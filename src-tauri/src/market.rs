//! 插件市场：拉索引、下载 zip、装到用户插件目录。
//!
//! 所有网络请求都在 Rust 侧做（reqwest 阻塞版）：
//! WebView 里 fetch 会被 CORS 拦，而 jsDelivr / Gitee raw 对 `file://` 与自定义
//! 协议来源都不友好，绕开浏览器是最省事的做法。
//!
//! 安装 zip 时手动校验每个条目路径，拒绝 `..` 与绝对路径（zip slip）。

use crate::plugin_abi;
use crate::plugin_perm;
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

/// 安装前先看包里到底要什么：清单、实际 ABI、申请的宿主能力
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
}

/// 从 zip 字节里读清单 + wasm 文件头，不落盘
fn inspect_zip(bytes: &[u8]) -> Result<(PluginManifest, Vec<u8>, bool), String> {
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

    let raw = {
        let mut file = archive
            .by_name(&manifest_name)
            .map_err(|e| format!("读取 plugin.json 失败：{e}"))?;
        let mut text = String::new();
        file.read_to_string(&mut text)
            .map_err(|e| format!("读取 plugin.json 失败：{e}"))?;
        text
    };
    let manifest: PluginManifest =
        serde_json::from_str(&raw).map_err(|e| format!("plugin.json 格式不对：{e}"))?;

    let prefix = manifest_name
        .strip_suffix("plugin.json")
        .unwrap_or_default()
        .to_string();
    let entry_name = format!("{prefix}{}", manifest.entry.replace('\\', "/"));

    let mut header = Vec::new();
    let mut has_entry = false;
    if let Ok(mut file) = archive.by_name(&entry_name) {
        has_entry = true;
        let mut buf = [0u8; 8];
        let n = file.read(&mut buf).unwrap_or(0);
        header.extend_from_slice(&buf[..n]);
    }
    Ok((manifest, header, has_entry))
}

/// 把一个包的清单翻译成「装之前要不要提醒」的那点信息
fn peek_bytes(bytes: &[u8]) -> Result<PluginPeek, String> {
    let (manifest, header, has_entry) = inspect_zip(bytes)?;
    let abi = if header.is_empty() {
        manifest.abi
    } else {
        plugin_abi::effective_abi(manifest.abi, plugin_abi::detect(&header))
    };
    let grant = plugin_perm::Grant::resolve(manifest.permissions.as_deref(), abi);
    Ok(PluginPeek {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        abi,
        permissions: grant.keys().to_vec(),
        unknown_permissions: grant.unknown().to_vec(),
        has_entry,
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
fn install_from_bytes(base: &Path, bytes: &[u8]) -> Result<PluginManifest, String> {
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
    let manifest = install_from_bytes(&state.plugin_dir, &bytes)?;
    if manifest.id != id {
        // id 不一致说明市场索引和包对不上，装上也会找不着，直接退回去
        let dir = state.plugin_dir.join(&manifest.id);
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("索引里的 id（{id}）与包里的（{}）不一致", manifest.id));
    }
    Ok(state.plugins.list())
}

/// 安装本地 zip 前先看清单：前端据此提示「这个插件要哪些能力」
#[tauri::command]
pub fn plugin_peek_zip(path: String) -> Result<PluginPeek, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    if meta.len() > MAX_ZIP_BYTES {
        return Err("插件包超过 32MB".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    peek_bytes(&bytes)
}

/// 从本地 zip 安装（自己也打的包 / 离线安装）
#[tauri::command]
pub fn plugin_install_zip(state: State<'_, AppState>, path: String) -> Result<Vec<PluginInfo>, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    if meta.len() > MAX_ZIP_BYTES {
        return Err("插件包超过 32MB".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    install_from_bytes(&state.plugin_dir, &bytes)?;
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

// ---------------- 安装前看清单（纯逻辑，不需要网络与磁盘） ----------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_with(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, data) in files {
                zip.start_file(*name, opts).unwrap();
                zip.write_all(data).unwrap();
            }
            zip.finish().unwrap();
        }
        buf
    }

    const COMPONENT_HEAD: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00];
    const CORE_HEAD: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

    #[test]
    fn peeks_flat_package() {
        let manifest = r#"{"id":"demo","name":"示例","version":"0.3.0","abi":2,
                           "permissions":["log","read-setting"]}"#;
        let bytes = zip_with(&[("plugin.json", manifest.as_bytes()), ("plugin.wasm", &COMPONENT_HEAD)]);
        let peek = peek_bytes(&bytes).unwrap();

        assert_eq!(peek.id, "demo");
        assert_eq!(peek.abi, plugin_abi::ABI_COMPONENT);
        assert_eq!(peek.permissions, ["log", "read-setting"]);
        assert!(peek.unknown_permissions.is_empty());
        assert!(peek.has_entry);
    }

    #[test]
    fn peeks_nested_package() {
        // 市场里常见的「外面套一层文件夹」的包
        let manifest = r#"{"id":"csv-viewer","name":"CSV","version":"0.3.0","abi":2}"#;
        let bytes = zip_with(&[
            ("csv-viewer/plugin.json", manifest.as_bytes()),
            ("csv-viewer/plugin.wasm", &COMPONENT_HEAD),
            ("csv-viewer/README.md", b"# hi"),
        ]);
        let peek = peek_bytes(&bytes).unwrap();
        assert_eq!(peek.id, "csv-viewer");
        assert!(peek.has_entry);
        // 没写 permissions 的 v2 插件：默认什么都不给
        assert!(peek.permissions.is_empty());
    }

    #[test]
    fn header_wins_over_declared_abi() {
        // 声明 v2 但包里的还是核心模块：按 v1 算，也就回到 v1 的默认能力
        let manifest = r#"{"id":"confused","name":"搞错了","version":"0.1.0","abi":2}"#;
        let bytes = zip_with(&[("plugin.json", manifest.as_bytes()), ("plugin.wasm", &CORE_HEAD)]);
        let peek = peek_bytes(&bytes).unwrap();
        assert_eq!(peek.abi, plugin_abi::ABI_LEGACY);
        assert_eq!(peek.permissions, ["log", "now-ms"]);
    }

    #[test]
    fn flags_missing_wasm() {
        let manifest = r#"{"id":"half","name":"半成品","version":"0.1.0","abi":2}"#;
        let bytes = zip_with(&[("plugin.json", manifest.as_bytes())]);
        let peek = peek_bytes(&bytes).unwrap();
        assert!(!peek.has_entry);
    }

    #[test]
    fn reports_unknown_permission_names() {
        let manifest = r#"{"id":"x","name":"x","version":"0.1.0","abi":2,
                           "permissions":["log","network"]}"#;
        let bytes = zip_with(&[("plugin.json", manifest.as_bytes()), ("plugin.wasm", &COMPONENT_HEAD)]);
        let peek = peek_bytes(&bytes).unwrap();
        assert_eq!(peek.permissions, ["log"]);
        assert_eq!(peek.unknown_permissions, ["network"]);
    }

    #[test]
    fn package_without_manifest_is_rejected() {
        let bytes = zip_with(&[("plugin.wasm", &COMPONENT_HEAD)]);
        let err = peek_bytes(&bytes).unwrap_err();
        assert!(err.contains("plugin.json"), "{err}");
    }
}
