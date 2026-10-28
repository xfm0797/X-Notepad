//! 文件系统：目录树遍历、按编码读、按编码写、编码检测
//!
//! 关键点：编辑器必须"读进来什么样、存回去还什么样"，
//! 所以读的时候记录编码与换行符，写的时候按原样还原。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 目录树节点（前端 TreeView 直接消费）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// 小写扩展名（不含点），目录为空
    pub ext: String,
    pub children: Option<Vec<Node>>,
}

/// 读文件结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePayload {
    pub path: String,
    pub content: String,
    /// "UTF-8" / "GBK" / "Shift_JIS" …
    pub encoding: String,
    /// "LF" | "CRLF"
    pub eol: String,
    pub size: u64,
    /// 二进制文件不返回内容
    pub binary: bool,
    pub mtime: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub size: u64,
    pub mtime: u64,
}

/// 只回 size/mtime，用于判断磁盘文件是否被外部改动
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub exists: bool,
    pub size: u64,
    pub mtime: u64,
}

/// 不参与遍历的重目录
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "dist-updater",
    ".next",
    ".venv",
    "__pycache__",
];

pub(crate) fn is_skipped(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}

fn mtime_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn walk(dir: &Path, depth: u32, max_depth: u32) -> Vec<Node> {
    let mut nodes = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return nodes;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".env" {
            // 隐藏文件不进树，避免 .git / .DS_Store 干扰
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let is_dir = meta.is_dir();
        if is_dir && is_skipped(&name) {
            continue;
        }
        let ext = if is_dir {
            String::new()
        } else {
            path.extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        };
        let children = if is_dir && depth < max_depth {
            Some(walk(&path, depth + 1, max_depth))
        } else if is_dir {
            Some(Vec::new())
        } else {
            None
        };
        nodes.push(Node {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            ext,
            children,
        });
        if nodes.len() > 5000 {
            break;
        }
    }
    // 目录在前，其余按名称不区分大小写排序
    nodes.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    nodes
}

/// 读取目录树（根节点自身不返回，只返回子项）
#[tauri::command]
pub fn ws_tree(root: String, depth: Option<u32>) -> Result<Vec<Node>, String> {
    let p = PathBuf::from(&root);
    if !p.is_dir() {
        return Err(format!("不是有效目录：{root}"));
    }
    Ok(walk(&p, 0, depth.unwrap_or(6)))
}

/// 判断是不是二进制（前 8KB 出现 0 字节即认为二进制）
pub(crate) fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

/// 编码检测 + 解码，返回 (文本, 编码名)
pub(crate) fn decode(bytes: &[u8]) -> (String, String) {
    // 先按 UTF-8 严格试一次，绝大多数文件走这条快路
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_string(), "UTF-8".to_string());
    }
    // chardetng 1.0 起这两项不再是 bool：new() 要 Iso2022JpDetection，
    // guess() 要 Utf8Detection。文本编辑器两个都放开——
    // 我们不是在按 HTML 规范解析网页，猜错也只是显示乱码，不会执行脚本。
    let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
    det.feed(bytes, true);
    let enc = det.guess(None, chardetng::Utf8Detection::Allow);
    let (text, _, _) = enc.decode(bytes);
    (text.to_string(), enc.name().to_string())
}

pub(crate) fn encode(text: &str, encoding: &str) -> Result<Vec<u8>, String> {
    if encoding.eq_ignore_ascii_case("utf-8") {
        return Ok(text.as_bytes().to_vec());
    }
    let enc = encoding_rs::Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("不支持的编码：{encoding}"))?;
    let (bytes, _, had_errors) = enc.encode(text);
    if had_errors {
        return Err(format!(
            "内容包含 {encoding} 无法表示的字符，请改用 UTF-8 保存"
        ));
    }
    Ok(bytes.into_owned())
}

pub(crate) fn eol_of(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "CRLF"
    } else {
        "LF"
    }
}

/// 统一成 LF，写入时再按目标换行符还原
pub(crate) fn normalize_eol(text: &str) -> String {
    text.replace("\r\n", "\n")
}

pub(crate) fn apply_eol(text: &str, eol: &str) -> String {
    let lf = normalize_eol(text);
    if eol.eq_ignore_ascii_case("crlf") {
        lf.replace('\n', "\r\n")
    } else {
        lf
    }
}

#[tauri::command]
pub fn file_read(path: String) -> Result<FilePayload, String> {
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("读取失败：{e}"))?;
    if meta.is_dir() {
        return Err("目标是目录".into());
    }
    // 大于 32MB 的文件先不读进内存，0.1.0 用提示代替分块加载
    if meta.len() > 32 * 1024 * 1024 {
        return Err(format!(
            "文件 {} MB，超过 0.1.0 的 32MB 上限",
            meta.len() / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("读取失败：{e}"))?;
    let binary = looks_binary(&bytes);
    let (content, encoding) = if binary {
        (String::new(), "binary".to_string())
    } else {
        decode(&bytes)
    };
    Ok(FilePayload {
        path,
        eol: eol_of(&content).to_string(),
        size: meta.len(),
        binary,
        mtime: mtime_secs(&meta),
        content,
        encoding,
    })
}

/// 按编码 + 换行符落盘（先写临时文件再原子替换）。
///
/// `file_write` 和全库替换共用这一条路径，保证「读进来什么样、存回去还什么样」。
pub(crate) fn write_text(
    path: &Path,
    content: &str,
    encoding: &str,
    eol: &str,
) -> Result<SaveResult, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let bytes = encode(&apply_eol(content, eol), encoding)?;
    // 先写临时文件再原子替换：避免崩溃时留下半个文件
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default()
    ));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写入失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("保存失败：{e}")
    })?;
    let meta = std::fs::metadata(path).map_err(|e| format!("保存后校验失败：{e}"))?;
    Ok(SaveResult {
        size: meta.len(),
        mtime: mtime_secs(&meta),
    })
}

/// 读成「LF 文本 + 编码 + 原换行符」，读不了（目录 / 太大 / 二进制）返回 None。
/// 替换用得上：只处理文本文件，编码和换行符都要原样带回去。
pub(crate) fn read_text(path: &Path, max_bytes: u64) -> Option<(String, String, String)> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max_bytes {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if looks_binary(&bytes) {
        return None;
    }
    let (text, encoding) = decode(&bytes);
    let eol = eol_of(&text).to_string();
    Some((normalize_eol(&text), encoding, eol))
}

#[tauri::command]
pub fn file_write(path: String, content: String, encoding: String, eol: String) -> Result<SaveResult, String> {
    let p = PathBuf::from(&path);
    write_text(&p, &content, &encoding, &eol)
}

/// 文件状态。文件不存在也不报错，前端靠 exists 判断"被删了"
#[tauri::command]
pub fn file_stat(path: String) -> FileStat {
    match std::fs::metadata(&path) {
        Ok(meta) => FileStat {
            exists: true,
            size: meta.len(),
            mtime: mtime_secs(&meta),
        },
        Err(_) => FileStat {
            exists: false,
            size: 0,
            mtime: 0,
        },
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CreateKind {
    File,
    Dir,
}

#[tauri::command]
pub fn file_create(path: String, kind: CreateKind) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err("同名文件已存在".into());
    }
    match kind {
        CreateKind::File => {
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&p, b"").map_err(|e| format!("创建失败：{e}"))
        }
        CreateKind::Dir => std::fs::create_dir_all(&p).map_err(|e| format!("创建失败：{e}")),
    }
}

#[tauri::command]
pub fn file_rename(from: String, to: String) -> Result<(), String> {
    let (a, b) = (PathBuf::from(&from), PathBuf::from(&to));
    if !a.exists() {
        return Err("源文件不存在".into());
    }
    if b.exists() && a != b {
        return Err("目标已存在".into());
    }
    std::fs::rename(&a, &b).map_err(|e| format!("重命名失败：{e}"))
}

#[tauri::command]
pub fn file_delete(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("删除失败：{e}"))
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("删除失败：{e}"))
    }
}
