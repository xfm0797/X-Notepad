//! 笔记元数据：标签、收藏、最近打开（SQLite）
//!
//! 正文永远留在文件里，这里只存"文件的附加信息"，
//! 所以即使 db 丢了笔记也不受影响，重新打开会自动重建条目。

use crate::AppState;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub path: String,
    pub title: String,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub opened_at: i64,
    pub opened_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS files (
            path         TEXT PRIMARY KEY,
            title        TEXT NOT NULL DEFAULT '',
            tags         TEXT NOT NULL DEFAULT '',
            favorite     INTEGER NOT NULL DEFAULT 0,
            opened_at    INTEGER NOT NULL DEFAULT 0,
            opened_count INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_files_opened ON files(opened_at DESC);
        "#,
    )
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn split_tags(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// 打开文件时调用：记录打开时间、累加次数
#[tauri::command]
pub fn meta_touch(state: State<'_, AppState>, path: String, title: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        r#"INSERT INTO files (path, title, opened_at, opened_count) VALUES (?1, ?2, ?3, 1)
           ON CONFLICT(path) DO UPDATE SET
             title = excluded.title,
             opened_at = excluded.opened_at,
             opened_count = files.opened_count + 1"#,
        params![path, title, now_secs()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn meta_recent(state: State<'_, AppState>, limit: Option<i64>) -> Result<Vec<Recent>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT path, title, tags, favorite, opened_at, opened_count
             FROM files ORDER BY opened_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit.unwrap_or(20)], |row| {
            Ok(Recent {
                path: row.get(0)?,
                title: row.get(1)?,
                tags: split_tags(&row.get::<_, String>(2)?),
                favorite: row.get::<_, i64>(3)? != 0,
                opened_at: row.get(4)?,
                opened_count: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn meta_set_tags(state: State<'_, AppState>, path: String, tags: Vec<String>) -> Result<(), String> {
    let joined = tags
        .iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(",");
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        r#"INSERT INTO files (path, tags, opened_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(path) DO UPDATE SET tags = excluded.tags"#,
        params![path, joined, now_secs()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 全部标签及其出现次数（用于标签面板）
#[tauri::command]
pub fn meta_list_tags(state: State<'_, AppState>) -> Result<Vec<TagCount>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT tags FROM files WHERE tags <> ''")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;

    let mut counter: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for tags in rows.flatten() {
        for tag in split_tags(&tags) {
            *counter.entry(tag).or_insert(0) += 1;
        }
    }
    let mut out: Vec<TagCount> = counter
        .into_iter()
        .map(|(tag, count)| TagCount { tag, count })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then(a.tag.cmp(&b.tag)));
    Ok(out)
}
