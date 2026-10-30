//! 插件市场：拉索引、下载 zip、装到用户插件目录。
//!
//! 所有网络请求都在 Rust 侧做（reqwest 阻塞版）：
//! WebView 里 fetch 会被 CORS 拦，而 jsDelivr / Gitee raw 对 `file://` 与自定义
//! 协议来源都不友好，绕开浏览器是最省事的做法。
//!
//! 安装 zip 时手动校验每个条目路径，拒绝 `..` 与绝对路径（zip slip）。
//!
//! 签名（[`crate::plugin_sig`]）在**解包之前**验：内容对不上、签名不成立就整包拒绝，
//! 不会有半个包落进插件目录。没签名 / 密钥不认识只提示，不拦。

use crate::plugin_abi;
use crate::plugin_perm;
use crate::plugin_sig::{self, SignatureInfo, TrustedKey};
use crate::plugins::{PluginInfo, PluginManifest};
use crate::AppState;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::State;

/// 索引不允许超过 1MB，插件包 32MB
const MAX_INDEX_BYTES: u64 = 1 << 20;
const MAX_ZIP_BYTES: u64 = 32 << 20;

fn http_get(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("X-Notepad/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))?;

    let resp = client.get(url).send().map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    if let Some(len) = resp.content_length() {
        if len > limit {
            return Err(format!("响应过大：{} KB", len / 1024));
        }
    }

    // 没有 Content-Length 时也要有上限，take 一个字节多留作判断
    let mut buf = Vec::new();
    resp.take(limit + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if buf.len() as u64 > limit {
        return Err("响应超过大小上限".into());
    }
    Ok(buf)
}

/// 拉市场索引（原样返回 JSON 文本，解析交给前端）
#[tauri::command]
pub fn market_fetch(url: String) -> Result<String, String> {
    let bytes = http_get(&url, MAX_INDEX_BYTES)?;
    String::from_utf8(bytes).map_err(|e| format!("索引不是 UTF-8：{e}"))
}

/// 只有这些字符能当目录名
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !id.starts_with('.')
}

/// 把 zip 里的相对路径安全地拼到 base 下
fn safe_join(base: &Path, name: &str) -> Option<PathBuf> {
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains(':') {
        return None;
    }
    let mut out = base.to_path_buf();
    for seg in normalized.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return None;
        }
        out.push(seg);
    }
    Some(out)
}

/// 信任名单：内置官方密钥 + 用户自己加的
fn keys_of(state: &AppState) -> Vec<TrustedKey> {
    plugin_sig::trusted_keys(plugin_sig::load_keys(&state.key_store))
}

/// 安装前先看包里到底要什么：清单、实际 ABI、申请的宿主能力、签名
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPeek {
    pub id: String,
    pub name: String,
    pub version: String,
    /// 按 wasm 文件头算的实际 ABI（包里没有 wasm 时退回清单声明）
    pub abi: u32,
    pub permissions: Vec<String>,
    pub unknown_permissions: Vec<String>,
    /// 包里有没有清单 entry 指向的 wasm
    pub has_entry: bool,
    /// 签名状态：verified / untrusted / unsigned / invalid
    pub signature: SignatureInfo,
}

/// 拆开的包：清单 + 清单目录里的全部文件（路径相对清单目录）
struct Package {
    manifest: PluginManifest,
    files: Vec<(String, Vec<u8>)>,
    has_entry: bool,
}

/// 从 zip 字节里读清单 + 所有文件，不落盘
fn read_package(bytes: &[u8]) -> Result<Package, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("不是有效的 zip 包：{e}"))?;

    // 找最浅的那个 plugin.json：允许平铺，也允许外面套一层文件夹
    let mut pick: Option<(usize, String)> = None;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("读取压缩包条目失败：{e}"))?;
        let name = entry.name().replace('\\', "/");
        if name == "plugin.json" || name.ends_with("/plugin.json") {
            let depth = name.matches('/').count();
            if depth <= 1 && pick.as_ref().map_or(true, |(d, _)| depth < *d) {
                pick = Some((depth, name));
            }
        }
    }
    let Some((_, manifest_name)) = pick else {
        return Err("压缩包里没有 plugin.json".into());
    };

    let prefix = manifest_name
        .strip_suffix("plugin.json")
        .unwrap_or_default()
        .to_string();

    // 清单目录下的文件全取出来：摘要要把它们一个不落地算进去
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取压缩包条目失败：{e}"))?;
        if entry.is_dir() {
            continue;
        }
        let zip_name = entry.name().replace('\\', "/");
        let Some(rel) = zip_name.strip_prefix(prefix.as_str()) else {
            continue;
        };
        if rel.is_empty() {
            continue;
        }
        let rel = rel.to_string();
        let mut data = Vec::new();
        entry
            .read_to_end(&mut data)
            .map_err(|e| format!("读取 {zip_name} 失败：{e}"))?;
        files.push((rel, data));
    }

    let raw = files
        .iter()
        .find(|(name, _)| name == "plugin.json")
        .map(|(_, data)| String::from_utf8_lossy(data).to_string())
        .ok_or_else(|| "读取 plugin.json 失败".to_string())?;
    let manifest: PluginManifest =
        serde_json::from_str(&raw).map_err(|e| format!("plugin.json 格式不对：{e}"))?;

    let entry_name = manifest.entry.replace('\\', "/");
    let has_entry = files.iter().any(|(name, _)| *name == entry_name);

    Ok(Package {
        manifest,
        files,
        has_entry,
    })
}

/// 验签 + 把清单翻译成「装之前要不要提醒」的那点信息
fn peek_bytes(bytes: &[u8], keys: &[TrustedKey]) -> Result<PluginPeek, String> {
    let pkg = read_package(bytes)?;
    let header = pkg
        .files
        .iter()
        .find(|(name, _)| *name == pkg.manifest.entry.replace('\\', "/"))
        .map(|(_, data)| data[..data.len().min(8)].to_vec())
        .unwrap_or_default();
    let abi = if header.is_empty() {
        pkg.manifest.abi
    } else {
        plugin_abi::effective_abi(pkg.manifest.abi, plugin_abi::detect(&header))
    };
    let grant = plugin_perm::Grant::resolve(pkg.manifest.permissions.as_deref(), abi);
    let signature = plugin_sig::verify_files(
        &pkg.files,
        plugin_sig::block_of(&pkg.files).as_deref(),
        keys,
    );
    Ok(PluginPeek {
        id: pkg.manifest.id,
        name: pkg.manifest.name,
        version: pkg.manifest.version,
        abi,
        permissions: grant.keys().to_vec(),
        unknown_permissions: grant.unknown().to_vec(),
        has_entry: pkg.has_entry,
        signature,
    })
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn unpack(zip_bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes))
        .map_err(|e| format!("不是有效的 zip 包：{e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取压缩包条目失败：{e}"))?;
        let name = entry.name().to_string();
        let Some(out) = safe_join(dest, &name) else {
            continue;
        };

        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("创建目录失败：{e}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        let mut file = std::fs::File::create(&out).map_err(|e| format!("写入失败：{e}"))?;
        std::io::copy(&mut entry, &mut file).map_err(|e| format!("解压失败：{e}"))?;
    }
    Ok(())
}

/// 找 plugin.json 所在目录：支持 zip 里平铺，也支持外面套一层文件夹
fn find_manifest_dir(dir: &Path) -> Option<PathBuf> {
    if dir.join("plugin.json").is_file() {
        return Some(dir.to_path_buf());
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() && p.join("plugin.json").is_file() {
            return Some(p);
        }
    }
    None
}

/// 解包 + 校验 + 落盘，返回清单
fn install_from_bytes(base: &Path, bytes: &[u8], keys: &[TrustedKey]) -> Result<PluginManifest, String> {
    // 先验签再解包：内容被改过的包一个字节都不落盘
    let pkg = read_package(bytes)?;
    let sig = plugin_sig::verify_files(
        &pkg.files,
        plugin_sig::block_of(&pkg.files).as_deref(),
        keys,
    );
    if sig.status.is_fatal() {
        return Err(format!("签名校验没通过，已拒绝安装：{}", sig.detail));
    }

    std::fs::create_dir_all(base).map_err(|e| format!("创建插件目录失败：{e}"))?;

    let tmp = base.join(format!(".unpack-{}", now_millis()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("创建临时目录失败：{e}"))?;

    if let Err(e) = unpack(bytes, &tmp) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }

    let cleanup = |tmp: &Path| {
        let _ = std::fs::remove_dir_all(tmp);
    };

    let Some(src) = find_manifest_dir(&tmp) else {
        cleanup(&tmp);
        return Err("压缩包里没有 plugin.json".into());
    };

    let raw = match std::fs::read_to_string(src.join("plugin.json")) {
        Ok(s) => s,
        Err(e) => {
            cleanup(&tmp);
            return Err(format!("读取 plugin.json 失败：{e}"));
        }
    };
    let manifest: PluginManifest = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => {
            cleanup(&tmp);
            return Err(format!("plugin.json 格式不对：{e}"));
        }
    };

    if !valid_id(&manifest.id) {
        cleanup(&tmp);
        return Err(format!("插件 id 不合法：{}", manifest.id));
    }
    if !src.join(&manifest.entry).is_file() {
        let missing = manifest.entry.clone();
        cleanup(&tmp);
        return Err(format!("插件包里缺少 {missing}，作者可能忘了编译"));
    }

    let target = base.join(&manifest.id);
    if target.exists() {
        let _ = std::fs::remove_dir_all(&target);
    }

    // 目录改名：同盘 rename 是原子操作
    let moved = if src == tmp {
        std::fs::rename(&tmp, &target)
    } else {
        let staged = base.join(format!(".stage-{}", manifest.id));
        let _ = std::fs::remove_dir_all(&staged);
        match std::fs::rename(&src, &staged) {
            Ok(()) => std::fs::rename(&staged, &target),
            Err(e) => Err(e),
        }
    };

    cleanup(&tmp);
    if let Err(e) = moved {
        return Err(format!("安装失败（写入 {}）：{e}", target.display()));
    }
    Ok(manifest)
}

/// 从市场 URL 安装
#[tauri::command]
pub fn plugin_install(
    state: State<'_, AppState>,
    id: String,
    url: String,
) -> Result<Vec<PluginInfo>, String> {
    if !valid_id(&id) {
        return Err(format!("插件 id 不合法：{id}"));
    }
    let bytes = http_get(&url, MAX_ZIP_BYTES)?;
    let manifest = install_from_bytes(&state.plugin_dir, &bytes, &keys_of(&state))?;
    if manifest.id != id {
        // id 不一致说明市场索引和包对不上，装上也会找不着，直接退回去
        let dir = state.plugin_dir.join(&manifest.id);
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("索引里的 id（{id}）与包里的（{}）不一致", manifest.id));
    }
    Ok(state.plugins.list())
}

/// 安装本地 zip 前先看清单：前端据此提示「这个插件要哪些能力」「是谁签的」
#[tauri::command]
pub fn plugin_peek_zip(state: State<'_, AppState>, path: String) -> Result<PluginPeek, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    if meta.len() > MAX_ZIP_BYTES {
        return Err("插件包超过 32MB".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    peek_bytes(&bytes, &keys_of(&state))
}

/// 从本地 zip 安装（自己也打的包 / 离线安装）
#[tauri::command]
pub fn plugin_install_zip(state: State<'_, AppState>, path: String) -> Result<Vec<PluginInfo>, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    if meta.len() > MAX_ZIP_BYTES {
        return Err("插件包超过 32MB".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    install_from_bytes(&state.plugin_dir, &bytes, &keys_of(&state))?;
    Ok(state.plugins.list())
}

#[tauri::command]
pub fn plugin_uninstall(state: State<'_, AppState>, id: String) -> Result<Vec<PluginInfo>, String> {
    if !valid_id(&id) {
        return Err(format!("插件 id 不合法：{id}"));
    }
    let dir = state.plugin_dir.join(&id);
    if !dir.is_dir() {
        return Err(format!("没有找到已安装的插件：{id}"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("卸载失败：{e}"))?;
    Ok(state.plugins.list())
}

/// 用户插件目录（UI 上展示 + 复制给用户手动丢文件）
#[tauri::command]
pub fn plugin_dir(state: State<'_, AppState>) -> String {
    state.plugin_dir.to_string_lossy().to_string()
}

// ---------------- 信任名单 ----------------

/// 当前信任的密钥（内置官方 + 用户加的）
#[tauri::command]
pub fn plugin_keys(state: State<'_, AppState>) -> Vec<TrustedKey> {
    keys_of(&state)
}

/// 加一把公钥。id 重复就是覆盖——换密钥的场景就是这样
#[tauri::command]
pub fn plugin_key_add(
    state: State<'_, AppState>,
    id: String,
    public_key: String,
    label: String,
) -> Result<Vec<TrustedKey>, String> {
    let id = id.trim().to_string();
    if !valid_id(&id) {
        return Err("密钥 id 只能用字母数字和 - _ .".into());
    }
    let key = normalize_pubkey(&public_key)?;
    let mut keys = plugin_sig::load_keys(&state.key_store);
    keys.retain(|k| k.id != id);
    keys.push(TrustedKey {
        id,
        public_key: key,
        label: label.trim().to_string(),
        builtin: false,
    });
    plugin_sig::save_keys(&state.key_store, &keys)?;
    Ok(keys_of(&state))
}

#[tauri::command]
pub fn plugin_key_remove(state: State<'_, AppState>, id: String) -> Result<Vec<TrustedKey>, String> {
    let mut keys = plugin_sig::load_keys(&state.key_store);
    keys.retain(|k| k.id != id);
    plugin_sig::save_keys(&state.key_store, &keys)?;
    Ok(keys_of(&state))
}

/// 公钥统一成小写十六进制；顺手容忍用户从网页上抄来的空格和冒号
fn normalize_pubkey(raw: &str) -> Result<String, String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ':')
        .collect::<String>()
        .to_ascii_lowercase();
    if cleaned.len() != 64 || !cleaned.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("公钥应该是 64 个十六进制字符（32 字节）".into());
    }
    Ok(cleaned)
}

// ---------------- 安装前看清单（纯逻辑，不需要网络与磁盘） ----------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_sig::{content_digest, sha256_hex};
    use ed25519_dalek::{Signer, SigningKey};
    use std::io::Write;

    fn zip_with(files: &[(&str, &[u8])]) -> Vec<u8> {
        let owned: Vec<(String, Vec<u8>)> =
            files.iter().map(|(n, d)| ((*n).to_string(), d.to_vec())).collect();
        zip_owned(&owned)
    }

    fn zip_owned(files: &[(String, Vec<u8>)]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, data) in files {
                zip.start_file(name.as_str(), opts).unwrap();
                zip.write_all(data).unwrap();
            }
            zip.finish().unwrap();
        }
        buf
    }

    const COMPONENT_HEAD: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00];
    const CORE_HEAD: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

    /// 单测用的固定密钥
    fn test_key() -> TrustedKey {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        TrustedKey {
            id: "test-key".into(),
            public_key: hex(&sk.verifying_key().to_bytes()),
            label: "测试".into(),
            builtin: false,
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// 给一组文件按包格式签个名
    fn signature_for(files: &[(String, Vec<u8>)]) -> String {
        let digest = content_digest(files);
        let raw: Vec<u8> = (0..32)
            .map(|i| u8::from_str_radix(&digest[i * 2..i * 2 + 2], 16).unwrap())
            .collect();
        let sig = SigningKey::from_bytes(&[7u8; 32]).sign(&raw);
        format!(
            r#"{{"algo":"ed25519","keyId":"test-key","digest":"{digest}","signature":"{}"}}"#,
            hex(&sig.to_bytes())
        )
    }

    /// 把文件列表塞进 zip（可以顺手带签名）。
    /// `files` 里的路径相对清单目录，`prefix` 用来模拟「外面套一层文件夹」的包——
    /// 摘要按相对路径算，所以签名和压缩前缀无关。
    fn signed_zip_in(prefix: &str, files: &[(&str, &[u8])], sign: bool) -> Vec<u8> {
        let mut all: Vec<(String, Vec<u8>)> = files
            .iter()
            .map(|(n, d)| (format!("{prefix}{n}"), d.to_vec()))
            .collect();
        if sign {
            let rel: Vec<(String, Vec<u8>)> =
                files.iter().map(|(n, d)| ((*n).to_string(), d.to_vec())).collect();
            all.push((
                format!("{prefix}signature.json"),
                signature_for(&rel).into_bytes(),
            ));
        }
        zip_owned(&all)
    }

    fn signed_zip(files: &[(&str, &[u8])], sign: bool) -> Vec<u8> {
        signed_zip_in("", files, sign)
    }

    fn demo_package() -> Vec<(&'static str, &'static [u8])> {
        vec![
            (
                "plugin.json",
                r#"{"id":"demo","name":"示例","version":"0.3.0","abi":2,"permissions":["log"]}"#
                    .as_bytes(),
            ),
            ("plugin.wasm", &COMPONENT_HEAD),
        ]
    }

    #[test]
    fn peeks_flat_package() {
        let bytes = signed_zip(&demo_package(), true);
        let peek = peek_bytes(&bytes, &[test_key()]).unwrap();

        assert_eq!(peek.id, "demo");
        assert_eq!(peek.abi, plugin_abi::ABI_COMPONENT);
        assert_eq!(peek.permissions, ["log"]);
        assert!(peek.unknown_permissions.is_empty());
        assert!(peek.has_entry);
        assert_eq!(peek.signature.status, plugin_sig::SigStatus::Verified);
        assert_eq!(peek.signature.key_id.as_deref(), Some("test-key"));
    }

    #[test]
    fn peeks_nested_package() {
        // 市场里常见的「外面套一层文件夹」的包
        let manifest = r#"{"id":"csv-viewer","name":"CSV","version":"0.3.0","abi":2}"#;
        let bytes = signed_zip_in(
            "csv-viewer/",
            &[
                ("plugin.json", manifest.as_bytes()),
                ("plugin.wasm", &COMPONENT_HEAD),
                ("README.md", b"# hi"),
            ],
            true,
        );
        let peek = peek_bytes(&bytes, &[test_key()]).unwrap();
        assert_eq!(peek.id, "csv-viewer");
        assert!(peek.has_entry);
        // 没写 permissions 的 v2 插件：默认什么都不给
        assert!(peek.permissions.is_empty());
        assert_eq!(peek.signature.status, plugin_sig::SigStatus::Verified);
    }

    #[test]
    fn unsigned_package_still_peeks() {
        let bytes = signed_zip(&demo_package(), false);
        let peek = peek_bytes(&bytes, &[test_key()]).unwrap();
        assert_eq!(peek.signature.status, plugin_sig::SigStatus::Unsigned);
        assert!(!peek.signature.status.is_fatal());
    }

    #[test]
    fn unknown_key_is_only_a_warning() {
        let bytes = signed_zip(&demo_package(), true);
        let peek = peek_bytes(&bytes, &[]).unwrap();
        assert_eq!(peek.signature.status, plugin_sig::SigStatus::Untrusted);
        assert_eq!(peek.signature.key_id.as_deref(), Some("test-key"));
    }

    #[test]
    fn tampered_package_is_flagged() {
        // 签名之后又改了 wasm：摘要是按文件内容算的，一改就对不上
        let files = demo_package();
        let mut all: Vec<(String, Vec<u8>)> =
            files.iter().map(|(n, d)| ((*n).to_string(), d.to_vec())).collect();
        let sig = signature_for(&all);
        all[1].1[3] = 0xff;
        all.push(("signature.json".into(), sig.into_bytes()));
        let zip = zip_owned(&all);
        let peek = peek_bytes(&zip, &[test_key()]).unwrap();
        assert_eq!(peek.signature.status, plugin_sig::SigStatus::Invalid);
    }

    #[test]
    fn header_wins_over_declared_abi() {
        // 声明 v2 但包里的还是核心模块：按 v1 算，也就回到 v1 的默认能力
        let manifest = r#"{"id":"confused","name":"搞错了","version":"0.1.0","abi":2}"#;
        let bytes = zip_with(&[("plugin.json", manifest.as_bytes()), ("plugin.wasm", &CORE_HEAD)]);
        let peek = peek_bytes(&bytes, &[test_key()]).unwrap();
        assert_eq!(peek.abi, plugin_abi::ABI_LEGACY);
        assert_eq!(peek.permissions, ["log", "now-ms"]);
    }

    #[test]
    fn flags_missing_wasm() {
        let manifest = r#"{"id":"half","name":"半成品","version":"0.1.0","abi":2}"#;
        let bytes = zip_with(&[("plugin.json", manifest.as_bytes())]);
        let peek = peek_bytes(&bytes, &[test_key()]).unwrap();
        assert!(!peek.has_entry);
    }

    #[test]
    fn reports_unknown_permission_names() {
        let manifest = r#"{"id":"x","name":"x","version":"0.1.0","abi":2,
                           "permissions":["log","network"]}"#;
        let bytes = zip_with(&[("plugin.json", manifest.as_bytes()), ("plugin.wasm", &COMPONENT_HEAD)]);
        let peek = peek_bytes(&bytes, &[test_key()]).unwrap();
        assert_eq!(peek.permissions, ["log"]);
        assert_eq!(peek.unknown_permissions, ["network"]);
    }

    #[test]
    fn package_without_manifest_is_rejected() {
        let bytes = zip_with(&[("plugin.wasm", &COMPONENT_HEAD)]);
        let err = peek_bytes(&bytes, &[test_key()]).unwrap_err();
        assert!(err.contains("plugin.json"), "{err}");
    }

    #[test]
    fn public_key_is_normalized() {
        let pretty = "FC:7D 17 0f\u{3000}6f1b3c61bc24deb8c6e19b88e110cc7c82bff637d0fd6da0e454d850";
        let out = normalize_pubkey(pretty).unwrap();
        assert_eq!(out.len(), 64);
        assert!(out.starts_with("fc7d170f"));
        assert!(normalize_pubkey("abc").is_err());
        assert!(normalize_pubkey(&"zz".repeat(32)).is_err());
    }

    #[test]
    fn sha_helper_matches_digest_style() {
        // 顺手确认测试里手搓的 hex 与真实实现一致
        assert_eq!(sha256_hex(b"abc").len(), 64);
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
