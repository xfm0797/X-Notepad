//! 全文搜索：SQLite FTS5 索引、CJK 分词、命中摘要
//!
//! 索引单独一个库文件（x-notepad-search.db），跟元数据库分开：
//! 重建索引是「删表重灌」的量级，不该和标签 / 收藏抢同一把锁。
//!
//! 分词用 FTS5 自带的 unicode61，但**中文要先自己切**：
//! unicode61 把一整串汉字当成一个 token，"笔记本" 里搜 "笔记" 是搜不到的。
//! 所以建索引和拼查询时都把汉字逐字空格隔开，查询侧用短语（"笔 记"），
//! 这样既能搜到连续汉字，又能靠末尾的 `*` 做前缀匹配（"笔记" → "笔记本"）。

use crate::fsx;
use crate::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

/// 单文件索引上限，再大就不进全文索引（编辑器里照样能打开）
const MAX_FILE: u64 = 1_500_000;
/// 一次返回的命中上限
const MAX_HITS: u32 = 200;
/// 只取正文前 20000 字符做摘要，避免大文件把内存拉满
const BODY_WINDOW: i64 = 20_000;

pub type Db = Arc<Mutex<Connection>>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub files: i64,
    pub built_at: i64,
    pub root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildReport {
    pub files: i64,
    pub built_at: i64,
    pub root: String,
    pub ms: u64,
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
    pub skipped: u32,
}

/// 摘要片段：hit 为 true 的片段前端加 <mark>
#[derive(Debug, Serialize)]
pub struct Seg {
    pub text: String,
    pub hit: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub path: String,
    pub name: String,
    /// bm25，越负越相关
    pub score: f64,
    /// 1 起算的行号 / 列号（列按字符数，前端换算成偏移）
    pub line: u32,
    pub column: u32,
    /// 该文件里命中的总次数
    pub matches: u32,
    pub snippet: Vec<Seg>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct QueryOptions {
    pub case_sensitive: bool,
    pub limit: Option<u32>,
    pub root: Option<String>,
}

/* ------------------------------------------------------------------ */
/* 建表                                                                 */
/* ------------------------------------------------------------------ */

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE IF NOT EXISTS docs (
            id    INTEGER PRIMARY KEY,
            path  TEXT NOT NULL UNIQUE,
            root  TEXT NOT NULL,
            mtime INTEGER NOT NULL,
            size  INTEGER NOT NULL,
            title TEXT NOT NULL,
            body  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_docs_root ON docs(root);

        CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
            path, title, body,
            tokenize = 'unicode61 remove_diacritics 2'
        );

        CREATE TABLE IF NOT EXISTS index_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )
}

/* ------------------------------------------------------------------ */
/* 分词与查询串                                                         */
/* ------------------------------------------------------------------ */

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3400..=0x4DBF   // 扩展 A
        | 0x4E00..=0x9FFF // 基本区
        | 0xF900..=0xFAFF // 兼容汉字
        | 0x3040..=0x30FF // 平假名 / 片假名
        | 0xAC00..=0xD7AF // 谚文
    )
}

/// 汉字逐字空格隔开，其余原样；连续空白压成一个空格
fn segment(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 4);
    let mut last_space = true;
    for ch in text.chars() {
        if is_cjk(ch) {
            if !last_space && !out.is_empty() {
                out.push(' ');
            }
            out.push(ch);
            out.push(' ');
            last_space = true;
        } else if ch.is_whitespace() {
            if !last_space && !out.is_empty() {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    out.trim_end().to_string()
}

/// 把用户输入拼成 FTS5 的 MATCH 表达式
///
/// - 多个词之间是 AND
/// - 每个词都加引号（双引号转义成两个），末尾缀 `*` 做前缀匹配
/// - 汉字先切分，于是 "笔记" 变成短语 `"笔 记"*`
fn build_match(query: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for raw in query.split_whitespace() {
        let term = raw.trim_end_matches('*');
        let seg = segment(term);
        if seg.is_empty() {
            continue;
        }
        parts.push(format!("\"{}\"*", seg.replace('"', "\"\"")));
    }
    parts.join(" AND ")
}

/* ------------------------------------------------------------------ */
/* 匹配 / 摘要                                                          */
/* ------------------------------------------------------------------ */

/// ASCII 大小写不敏感的查找，返回字节偏移。
///
/// 只在字节边界上逐字节滑动：needle 以 UTF-8 起始字节开头，
/// 而多字节字符的续字节都在 0x80..=0xBF，不会误配到字符中间。
fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let h = hay.as_bytes();
    let n = needle.as_bytes();
    if n.len() > h.len() {
        return None;
    }
    for i in 0..=h.len() - n.len() {
        if h[i..i + n.len()].eq_ignore_ascii_case(n) {
            return Some(i);
        }
    }
    None
}

fn find_in(hay: &str, needle: &str, case_sensitive: bool) -> Option<usize> {
    if case_sensitive {
        hay.find(needle)
    } else {
        find_ci(hay, needle)
    }
}

fn count_in(hay: &str, needle: &str, case_sensitive: bool) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut from = 0usize;
    while from <= hay.len() {
        let slice = &hay[from..];
        let Some(rel) = find_in(slice, needle, case_sensitive) else { break };
        count += 1;
        from += rel + needle.len().max(1);
        if count >= 9999 {
            break;
        }
    }
    count
}

fn line_col(text: &str, offset: usize) -> (u32, u32) {
    let offset = offset.min(text.len());
    let before = &text[..offset];
    let line = before.matches('\n').count() as u32 + 1;
    let line_start = before.rfind('\n').map(|i| i + 1).unwrap_or(0);
    let column = text[line_start..offset].chars().count() as u32 + 1;
    (line, column)
}

/// 把片段里的换行 / 制表符压成空格，前端一行就能显示完
fn flatten(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    out
}

/// 从 anchor 往前 back 个字符、往后 fwd 个字符切窗口
fn window(text: &str, anchor: usize, back: usize, fwd: usize) -> (usize, usize) {
    let mut start = anchor.min(text.len());
    for _ in 0..back {
        match text[..start].char_indices().next_back() {
            Some((i, _)) => start = i,
            None => break,
        }
    }
    let mut end = anchor.min(text.len());
    for _ in 0..fwd {
        match text[end..].chars().next() {
            Some(c) => end += c.len_utf8(),
            None => break,
        }
    }
    (start, end)
}

fn make_snippet(text: &str, anchor: usize, terms: &[String], case_sensitive: bool) -> Vec<Seg> {
    let (start, end) = window(text, anchor, 60, 120);
    let win = &text[start..end];

    // 窗口里所有命中区间，排序后合并重叠
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for t in terms {
        if t.is_empty() {
            continue;
        }
        let mut from = 0usize;
        while from <= win.len() {
            let Some(rel) = find_in(&win[from..], t, case_sensitive) else { break };
            let s = from + rel;
            ranges.push((s, s + t.len()));
            from = s + t.len().max(1);
        }
    }
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (s, e) in ranges {
        match merged.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => merged.push((s, e)),
        }
    }

    let mut segs: Vec<Seg> = Vec::new();
    let mut cursor = 0usize;
    for (s, e) in merged {
        if s > cursor {
            let piece = flatten(&win[cursor..s]);
            if !piece.is_empty() {
                segs.push(Seg { text: piece, hit: false });
            }
        }
        let piece = flatten(&win[s..e]);
        if !piece.is_empty() {
            segs.push(Seg { text: piece, hit: true });
        }
        cursor = e;
    }
    if cursor < win.len() {
        let piece = flatten(&win[cursor..]);
        if !piece.is_empty() {
            segs.push(Seg { text: piece, hit: false });
        }
    }
    if segs.is_empty() {
        segs.push(Seg {
            text: flatten(win),
            hit: false,
        });
    }
    if start > 0 {
        if let Some(first) = segs.first_mut() {
            first.text.insert(0, '…');
        }
    }
    if end < text.len() {
        if let Some(last) = segs.last_mut() {
            last.text.push('…');
        }
    }
    segs
}

/* ------------------------------------------------------------------ */
/* 建索引                                                               */
/* ------------------------------------------------------------------ */

fn mtime_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn collect_files(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 24 || out.len() > 20_000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 和文件树保持一致：隐藏文件不进索引（.env 例外）
        if name.starts_with('.') && name != ".env" {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if fsx::is_skipped(&name) {
                continue;
            }
            collect_files(&entry.path(), depth + 1, out);
        } else if meta.is_file() {
            out.push(entry.path());
        }
        if out.len() > 20_000 {
            return;
        }
    }
}

enum Upserted {
    Skipped,
    Added,
    Updated,
}

fn index_one(conn: &Connection, root: &str, path: &Path) -> rusqlite::Result<Upserted> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Ok(Upserted::Skipped);
    };
    if meta.len() > MAX_FILE {
        return Ok(Upserted::Skipped);
    }
    let Ok(bytes) = std::fs::read(path) else {
        return Ok(Upserted::Skipped);
    };
    if fsx::looks_binary(&bytes) {
        return Ok(Upserted::Skipped);
    }
    let (body, _encoding) = fsx::decode(&bytes);

    let path_str = path.to_string_lossy().to_string();
    let title = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mtime = mtime_secs(&meta);
    let size = meta.len() as i64;

    let old: Option<i64> = conn
        .query_row("SELECT id FROM docs WHERE path = ?1", params![&path_str], |r| r.get(0))
        .optional()?;
    if let Some(id) = old {
        // FTS 表要先按 rowid 删干净，否则会留下影子行
        conn.execute("DELETE FROM docs_fts WHERE rowid = ?1", params![id])?;
        conn.execute("DELETE FROM docs WHERE id = ?1", params![id])?;
    }

    conn.execute(
        "INSERT INTO docs (path, root, mtime, size, title, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![&path_str, root, mtime, size, &title, &body],
    )?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO docs_fts (rowid, path, title, body) VALUES (?1, ?2, ?3, ?4)",
        params![id, segment(&path_str), segment(&title), segment(&body)],
    )?;

    Ok(if old.is_some() {
        Upserted::Updated
    } else {
        Upserted::Added
    })
}

fn drop_by_id(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM docs_fts WHERE rowid = ?1", params![id])?;
    conn.execute("DELETE FROM docs WHERE id = ?1", params![id])?;
    Ok(())
}

fn read_meta(conn: &Connection, key: &str) -> String {
    conn.query_row(
        "SELECT value FROM index_meta WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or_default()
}

fn write_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO index_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn count_docs(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM docs", [], |r| r.get(0))
        .unwrap_or(0)
}

fn build_impl(db: &Db, root: &str) -> Result<BuildReport, String> {
    let started = std::time::Instant::now();
    let conn = db.lock().map_err(|e| e.to_string())?;
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        return Err(format!("不是有效目录：{root}"));
    }

    let mut files: Vec<PathBuf> = Vec::new();
    collect_files(&root_path, 0, &mut files);

    // 索引里属于这个根的旧记录：path -> (mtime, size)
    let mut existing: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT path, mtime, size FROM docs WHERE root = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![root], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?),
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            existing.insert(row.0, row.1);
        }
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut added = 0u32;
    let mut updated = 0u32;
    let mut skipped = 0u32;

    for path in &files {
        let key = path.to_string_lossy().to_string();
        let meta = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let stamp = (mtime_secs(&meta), meta.len() as i64);
        if let Some(seen) = existing.get(&key) {
            if *seen == stamp {
                // 没变，跳过，顺便从 existing 里摘掉
                existing.remove(&key);
                continue;
            }
            existing.remove(&key);
        }
        match index_one(&tx, root, path) {
            Ok(Upserted::Added) => added += 1,
            Ok(Upserted::Updated) => updated += 1,
            Ok(Upserted::Skipped) => skipped += 1,
            Err(e) => {
                // 单个文件出错不该让整次重建失败
                eprintln!("索引 {key} 失败：{e}");
                skipped += 1;
            }
        }
    }

    // 剩下的是磁盘上已经没有的
    let mut removed = 0u32;
    for key in existing.keys() {
        let id: Option<i64> = tx
            .query_row("SELECT id FROM docs WHERE path = ?1", params![key], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(id) = id {
            drop_by_id(&tx, id).map_err(|e| e.to_string())?;
            removed += 1;
        }
    }

    let built_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    write_meta(&tx, "root", root).map_err(|e| e.to_string())?;
    write_meta(&tx, "built_at", &built_at.to_string()).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(BuildReport {
        files: count_docs(&conn),
        built_at,
        root: root.to_string(),
        ms: started.elapsed().as_millis() as u64,
        added,
        updated,
        removed,
        skipped,
    })
}

/* ------------------------------------------------------------------ */
/* 查询                                                                 */
/* ------------------------------------------------------------------ */

fn query_impl(db: &Db, raw: &str, opts: &QueryOptions) -> Result<Vec<Hit>, String> {
    let query = raw.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| t.trim_end_matches('*').to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let expr = build_match(query);
    if expr.is_empty() {
        return Ok(Vec::new());
    }

    let conn = db.lock().map_err(|e| e.to_string())?;
    let limit = opts.limit.unwrap_or(MAX_HITS).clamp(1, 500) as i64;
    let root: Option<&str> = opts.root.as_deref();

    // bm25 列权重：path 1.2 / title 4.0 / body 1.0，标题命中排前面
    let mut stmt = conn
        .prepare(
            "SELECT d.path, d.title, substr(d.body, 1, ?3), d.mtime,
                    bm25(docs_fts, 1.2, 4.0, 1.0) AS score
             FROM docs_fts f JOIN docs d ON d.id = f.rowid
             WHERE f.docs_fts MATCH ?1 AND (?4 IS NULL OR d.root = ?4)
             ORDER BY score, d.mtime DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("准备查询失败：{e}"))?;

    let rows = stmt
        .query_map(params![&expr, limit, BODY_WINDOW, root], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, f64>(4)?,
            ))
        })
        .map_err(|e| format!("查询失败：{e}"))?;

    let mut hits: Vec<Hit> = Vec::new();
    for row in rows {
        let (path, title, body, _mtime, score) = row.map_err(|e| e.to_string())?;

        let mut anchor: Option<(usize, &str)> = None;
        for t in &terms {
            if let Some(pos) = find_in(&body, t, opts.case_sensitive) {
                if anchor.map_or(true, |(a, _)| pos < a) {
                    anchor = Some((pos, t.as_str()));
                }
            }
        }

        // 区分大小写时，正文没命中就再看标题 / 路径，都没有就丢掉
        if anchor.is_none()
            && opts.case_sensitive
            && !terms
                .iter()
                .any(|t| find_in(&title, t, true).is_some() || find_in(&path, t, true).is_some())
        {
            continue;
        }

        let matches: u32 = terms
            .iter()
            .map(|t| count_in(&body, t, opts.case_sensitive) as u32)
            .sum();
        let anchor_pos = anchor.map(|(p, _)| p).unwrap_or(0);
        let (line, column) = line_col(&body, anchor_pos);
        let snippet = make_snippet(&body, anchor_pos, &terms, opts.case_sensitive);

        hits.push(Hit {
            path,
            name: title,
            score,
            line,
            column,
            matches,
            snippet,
        });
    }

    Ok(hits)
}

/* ------------------------------------------------------------------ */
/* 命令                                                                 */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub async fn search_build(state: State<'_, AppState>, root: String) -> Result<BuildReport, String> {
    let db = state.search_db.clone();
    tauri::async_runtime::spawn_blocking(move || build_impl(&db, &root))
        .await
        .map_err(|e| format!("索引任务失败：{e}"))?
}

#[tauri::command]
pub async fn search_query(
    state: State<'_, AppState>,
    query: String,
    options: Option<QueryOptions>,
) -> Result<Vec<Hit>, String> {
    let db = state.search_db.clone();
    let opts = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || query_impl(&db, &query, &opts))
        .await
        .map_err(|e| format!("搜索任务失败：{e}"))?
}

/// 单个文件重灌（保存、外部改动、改名之后调用）
#[tauri::command]
pub fn search_update(state: State<'_, AppState>, path: String, root: Option<String>) -> Result<(), String> {
    let conn = state.search_db.lock().map_err(|e| e.to_string())?;
    let p = PathBuf::from(&path);
    let root = match root {
        Some(r) => r,
        None => read_meta(&conn, "root"),
    };
    if root.is_empty() {
        return Ok(());
    }
    if p.is_file() {
        index_one(&conn, &root, &p).map_err(|e| e.to_string())?;
    } else if !p.exists() {
        // 文件被删掉了：把这一条摘掉。目录事件什么都不做——
        // 删除目录由前端显式调 search_remove，别在这里连坐整棵子树
        drop_exact(&conn, &path)?;
    }
    Ok(())
}

fn drop_exact(conn: &Connection, path: &str) -> Result<(), String> {
    let id: Option<i64> = conn
        .query_row("SELECT id FROM docs WHERE path = ?1", params![path], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = id {
        drop_by_id(conn, id).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 删除一条或一整棵子树（删除 / 移动目录之后调用）
#[tauri::command]
pub fn search_remove(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let conn = state.search_db.lock().map_err(|e| e.to_string())?;
    drop_by_id_under(&conn, &path)?;
    Ok(())
}

fn drop_by_id_under(conn: &Connection, path: &str) -> Result<(), String> {
    let bs_prefix = format!("{path}\\");
    let fs_prefix = format!("{path}/");
    let ids: Vec<i64> = {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM docs
                 WHERE path = ?1 OR substr(path, 1, ?2) = ?3 OR substr(path, 1, ?4) = ?5",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    path,
                    bs_prefix.chars().count() as i64,
                    &bs_prefix,
                    fs_prefix.chars().count() as i64,
                    &fs_prefix
                ],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };
    for id in ids {
        drop_by_id(conn, id).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn search_status(state: State<'_, AppState>) -> Result<IndexStatus, String> {
    let conn = state.search_db.lock().map_err(|e| e.to_string())?;
    Ok(IndexStatus {
        files: count_docs(&conn),
        built_at: read_meta(&conn, "built_at").parse::<i64>().unwrap_or(0),
        root: read_meta(&conn, "root"),
    })
}
