//! 插件市场：拉索引、下载 zip、装到用户插件目录。
//!
//! 所有网络请求都在 Rust 侧做（reqwest 阻塞版）：
//! WebView 里 fetch 会被 CORS 拦，而 jsDelivr / Gitee raw 对 `file://` 与自定义
//! 协议来源都不友好，绕开浏览器是最省事的做法。
//!
//! 安装 zip 时手动校验每个条目路径，拒绝 `..` 与绝对路径（zip slip）。

use crate::plugins::{PluginInfo, PluginManifest};
use crate::AppState;
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
