//! 工作区文件监听。
//!
//! `notify` 在后台线程里收事件，这里只做三件事：
//! 1. 忽略噪音（.git / node_modules / 我们自己写的 .tmp）
//! 2. 把平台事件折叠成 created / modified / removed
//! 3. 通过 Tauri 事件推给前端，由前端决定要不要提示
//!
//! 去抖放在前端做：连续保存会连着来一串事件，攒 300ms 一起处理更省。

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

/// 推给前端的载荷
#[derive(Debug, Clone, Serialize)]
pub struct FsChange {
    pub kind: &'static str,
    pub paths: Vec<String>,
}

/// 不关心的目录（和 fsx 里的 SKIP_DIRS 保持一致）
const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "dist-updater",
    ".next",
    "__pycache__",
    ".venv",
];

pub fn should_ignore(path: &Path) -> bool {
    // 自己写文件时用的临时文件
    if path
        .file_name()
        .map(|n| n.to_string_lossy().ends_with(".tmp"))
        .unwrap_or(false)
    {
        return true;
    }
    for comp in path.components() {
        if let Component::Normal(seg) = comp {
            // 明确标注类型：Cow<str> 同时实现 AsRef<str>/AsRef<Path>，不写清楚会歧义
            let name: &str = &seg.to_string_lossy();
            if IGNORED_DIRS.contains(&name) {
                return true;
            }
        }
    }
    false
}

fn kind_of(event: &Event) -> Option<&'static str> {
    if matches!(event.kind, EventKind::Access(_)) {
        return None;
    }
    if matches!(event.kind, EventKind::Create(_)) {
        return Some("created");
    }
    if matches!(event.kind, EventKind::Remove(_)) {
        return Some("removed");
    }
    if matches!(event.kind, EventKind::Modify(_)) {
        return Some("modified");
    }
    Some("other")
}

/// 切换监听目录；重复调用会先停掉上一个监听
#[tauri::command]
pub fn watch_root(app: AppHandle, state: State<'_, AppState>, root: String) -> Result<(), String> {
    let mut slot = state.watcher.lock().map_err(|e| e.to_string())?;
    // 丢掉旧的 watcher 就等于停止监听
    *slot = None;

    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("不是有效目录：{root}"));
    }

    let emitter = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else { return };
        let Some(kind) = kind_of(&event) else { return };
        let paths: Vec<String> = event
            .paths
            .iter()
            .filter(|p| !should_ignore(p))
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        if paths.is_empty() {
            return;
        }
        let _ = emitter.emit("ws-change", FsChange { kind, paths });
    })
    .map_err(|e| format!("创建文件监听失败：{e}"))?;

    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| format!("监听目录失败：{e}"))?;

    *slot = Some(watcher);
    Ok(())
}
