//! X-Notepad：笔记 + 代码编辑器
//!
//! 设计原则：
//! - 文件读写、编码转换、Markdown 解析、插件执行全在 Rust 侧完成，前端只负责渲染
//! - 插件跑在 wasmtime 沙箱里，只能通过宿主显式导出的函数与外界通信

mod fsx;
mod markdown;
mod market;
mod meta;
mod plugins;
mod search;
mod watch;

use std::sync::{Arc, Mutex};
use tauri::Manager;

/// 全局状态：SQLite 连接 + 全文索引 + WASM 插件宿主 + 文件监听器
pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    /// 全文索引库（FTS5）。索引重建要跑几秒，所以用 Arc 好丢进阻塞线程池
    pub search_db: search::Db,
    pub plugins: plugins::PluginHost,
    /// 当前工作区的 watcher；换目录时整个替换掉
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// 用户插件目录（市场安装到这里）
    pub plugin_dir: std::path::PathBuf,
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

            // 全文索引库：单独一个文件，重建索引不会跟元数据抢锁。
            // 建表失败（比如 SQLite 没编 FTS5）不该拦住启动，只是搜索用不了
            let search_conn = rusqlite::Connection::open(data_dir.join("x-notepad-search.db"))?;
            if let Err(e) = search::init(&search_conn) {
                eprintln!("全文索引初始化失败（搜索不可用）：{e}");
            }

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
                search_db: Arc::new(Mutex::new(search_conn)),
                plugins: plugins::PluginHost::new(plugin_dirs.clone()),
                watcher: Mutex::new(None),
                plugin_dir: plugin_dirs[0].clone(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fsx::ws_tree,
            fsx::file_read,
            fsx::file_write,
            fsx::file_stat,
            fsx::file_create,
            fsx::file_rename,
            fsx::file_delete,
            watch::watch_root,
            markdown::md_render,
            meta::meta_touch,
            meta::meta_recent,
            meta::meta_set_tags,
            meta::meta_list_tags,
            plugins::plugin_list,
            plugins::plugin_run,
            search::search_build,
            search::search_query,
            search::search_update,
            search::search_remove,
            search::search_status,
            market::market_fetch,
            market::plugin_install,
            market::plugin_install_zip,
            market::plugin_uninstall,
            market::plugin_dir,
        ])
        .run(tauri::generate_context!())
        .expect("X-Notepad 启动失败");
}
