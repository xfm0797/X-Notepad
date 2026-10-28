//! 多窗口。
//!
//! 每个窗口是独立的 JS 上下文：store、标签、光标各管各的，文件监听也按窗口隔离
//! （见 `watch.rs`）。要打开的工作区 / 文件通过 URL 查询串带过去，
//! 新窗口启动时自己解析——比在进程里放一张「待打开」表简单，也不怕窗口晚加载。
//!
//! 会话（localStorage）按窗口 label 分 key：主窗口继续用 `xnp:session:v1`，
//! 其它窗口用 `xnp:session:v1:<label>`，于是升级上来的人不会丢原来的会话。

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// 窗口序号：只用递增数字，label 里不会出现非法字符
static SEQ: AtomicUsize = AtomicUsize::new(0);

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

pub fn spawn(app: &AppHandle, root: Option<&str>, file: Option<&str>) -> Result<String, String> {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("win-{seq}");

    let mut query = String::new();
    if let Some(r) = root.filter(|s| !s.is_empty()) {
        query.push_str(&format!("root={}", enc(r)));
    }
    if let Some(f) = file.filter(|s| !s.is_empty()) {
        if !query.is_empty() {
            query.push('&');
        }
        query.push_str(&format!("file={}", enc(f)));
    }
    let target = if query.is_empty() {
        "index.html".to_string()
    } else {
        format!("index.html?{query}")
    };

    // 尺寸给一个比主窗口略小的默认值；最小尺寸和主窗口保持一致
    let win = WebviewWindowBuilder::new(app, label.clone(), WebviewUrl::App(target.into()))
        .title("X-Notepad")
        .inner_size(1180.0, 800.0)
        .min_inner_size(880.0, 560.0)
        .build()
        .map_err(|e| format!("新建窗口失败：{e}"))?;
    let _ = win.set_focus();
    Ok(label)
}

/// 新开一个窗口。`root` 打开指定工作区，`path` 顺带打开某个文件
#[tauri::command]
pub fn window_new(
    app: AppHandle,
    root: Option<String>,
    path: Option<String>,
) -> Result<String, String> {
    spawn(&app, root.as_deref(), path.as_deref())
}
