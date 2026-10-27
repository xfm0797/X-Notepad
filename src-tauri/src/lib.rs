//! X-Notepad：笔记 + 代码编辑器
//!
//! 设计原则：
//! - 文件读写、编码转换、Markdown 解析、插件执行全在 Rust 侧完成，前端只负责渲染
//! - 插件跑在 wasmtime 沙箱里，只能通过宿主显式导出的函数与外界通信

mod fsx;
mod markdown;
mod meta;
mod plugins;

use std::sync::Mutex;
use tauri::Manager;

/// 全局状态：SQLite 连接 + WASM 插件宿主
pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub plugins: plugins::PluginHost,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            // 元数据库（标签 / 收藏 / 最近打开）
            let conn = rusqlite::Connection::open(data_dir.join("x-notepad.db"))?;
            meta::init(&conn)?;

            // 插件目录：用户数据目录（可写）+ 安装包资源目录（内置示例插件）
            let mut plugin_dirs = vec![data_dir.join("plugins")];
            if let Ok(res) = app.path().resource_dir() {
                plugin_dirs.push(res.join("plugins"));
            }
            for d in &plugin_dirs {
                let _ = std::fs::create_dir_all(d);
            }

            app.manage(AppState {
                db: Mutex::new(conn),
                plugins: plugins::PluginHost::new(plugin_dirs),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fsx::ws_tree,
            fsx::file_read,
            fsx::file_write,
            fsx::file_create,
            fsx::file_rename,
            fsx::file_delete,
            markdown::md_render,
            meta::meta_touch,
            meta::meta_recent,
            meta::meta_set_tags,
            meta::meta_list_tags,
            plugins::plugin_list,
            plugins::plugin_run,
        ])
        .run(tauri::generate_context!())
        .expect("X-Notepad 启动失败");
}
