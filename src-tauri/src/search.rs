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
use crate::snapshot;
use crate::AppState;
use regex::{Regex, RegexBuilder};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

/// 单文件索引上限，再大就不进全文索引（编辑器里照样能打开）
const MAX_FILE: u64 = 1_500_000;
/// 一次返回的命中上限
const MAX_HITS: u32 = 200;
/// 正则模式下最多扫多少个文件（正则没有索引，只能老老实实全表扫）
const MAX_SCAN_FILES: usize = 20_000;
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
    /// 正则模式：FTS5 没法表达正则，直接在索引里的正文上跑 regex
    pub regex: bool,
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

/// 把窗口里的命中区间合并、切成 hit/非 hit 片段
fn assemble(win: &str, ranges: Vec<(usize, usize)>, before: bool, after: bool) -> Vec<Seg> {
    let mut ranges: Vec<(usize, usize)> = ranges;
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
    if before {
        if let Some(first) = segs.first_mut() {
            first.text.insert(0, '…');
        }
    }
    if after {
        if let Some(last) = segs.last_mut() {
            last.text.push('…');
        }
    }
    segs
}

/// 以 anchor 为中心开窗，窗口内的命中区间交给 collect 算（词搜索 / 正则共用）
fn snippet_with<F>(text: &str, anchor: usize, collect: F) -> Vec<Seg>
where
    F: Fn(&str) -> Vec<(usize, usize)>,
{
    let (start, end) = window(text, anchor, 60, 120);
    let win = &text[start..end];
    assemble(win, collect(win), start > 0, end < text.len())
}

fn term_ranges(win: &str, terms: &[String], case_sensitive: bool) -> Vec<(usize, usize)> {
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
    ranges
}

fn make_snippet(text: &str, anchor: usize, terms: &[String], case_sensitive: bool) -> Vec<Seg> {
    snippet_with(text, anchor, |win| term_ranges(win, terms, case_sensitive))
}

/// 正则版的摘要：窗口内所有匹配区间（跳过空匹配，不然会切出零宽片段）
fn regex_snippet(text: &str, anchor: usize, re: &Regex) -> Vec<Seg> {
    snippet_with(text, anchor, |win| {
        re.find_iter(win)
            .filter(|m| m.end() > m.start())
            .map(|m| (m.start(), m.end()))
            .collect()
    })
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
    if opts.regex {
        // 正则里前后空格是有意义的，这里用原始输入，不 trim
        return regex_query_impl(db, raw, opts);
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
/* 正则                                                                 */
/* ------------------------------------------------------------------ */

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_string()
}

/// regex 的报错是多行的（原串 + 插入符 + `error: …`），
/// 只有最后一行 `error: xxx` 是人要看的，其余全丢掉
fn regex_error_text(e: &regex::Error) -> String {
    let raw = e.to_string();
    for line in raw.lines().rev() {
        if let Some(rest) = line.trim().strip_prefix("error:") {
            let rest = rest.trim();
            if !rest.is_empty() {
                return rest.to_string();
            }
        }
    }
    first_line(&raw)
}

/// 统一的正则编译入口：大小写、体积上限都在这里定，查询和替换共用
fn build_regex(pattern: &str, case_sensitive: bool) -> Result<Regex, String> {
    if pattern.is_empty() {
        return Err("正则表达式不能为空".into());
    }
    RegexBuilder::new(pattern)
        .case_insensitive(!case_sensitive)
        // 默认 10MB 的程序上限对我们够用，但显式写出来免得大文件被拒
        .size_limit(16 * 1024 * 1024)
        .dfa_size_limit(16 * 1024 * 1024)
        .build()
        .map_err(|e| format!("正则表达式无效：{}", regex_error_text(&e)))
}

/// 正则查询：FTS5 表达不了正则，直接在 docs 表的正文上跑。
/// 文件数上限 2 万，够笔记仓库用；再多就得考虑抽出独立进程了。
fn regex_query_impl(db: &Db, pattern: &str, opts: &QueryOptions) -> Result<Vec<Hit>, String> {
    let re = build_regex(pattern, opts.case_sensitive)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let limit = opts.limit.unwrap_or(MAX_HITS).clamp(1, 500) as usize;

    let mut stmt = conn
        .prepare("SELECT path, title, body FROM docs WHERE (?1 IS NULL OR root = ?1)")
        .map_err(|e| format!("准备查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![opts.root.as_deref()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("查询失败：{e}"))?;

    let mut hits: Vec<Hit> = Vec::new();
    let mut scanned = 0usize;
    for row in rows {
        let (path, title, body) = row.map_err(|e| e.to_string())?;
        scanned += 1;
        if scanned > MAX_SCAN_FILES {
            break;
        }

        let mut count = 0u32;
        let mut anchor: Option<usize> = None;
        for m in re.find_iter(&body) {
            if m.end() <= m.start() {
                continue;
            }
            if anchor.is_none() {
                anchor = Some(m.start());
            }
            count += 1;
            if count >= 9999 {
                break;
            }
        }
        // 正文没命中就看文件名 / 路径：正则经常是用来找命名规律的
        if anchor.is_none() {
            if !re.is_match(&title) && !re.is_match(&path) {
                continue;
            }
            count = 1;
        }

        let anchor_pos = anchor.unwrap_or(0);
        let (line, column) = line_col(&body, anchor_pos);
        hits.push(Hit {
            path,
            name: title,
            // 命中多的排前面；前端只用来排序，不显示这个数
            score: -(count as f64),
            line,
            column,
            matches: count,
            snippet: regex_snippet(&body, anchor_pos, &re),
        });
        if hits.len() >= limit {
            break;
        }
    }

    hits.sort_by(|a, b| {
        a.score
            .partial_cmp(&b.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(hits)
}

/* ------------------------------------------------------------------ */
/* 全库替换                                                             */
/* ------------------------------------------------------------------ */

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ReplaceOptions {
    pub case_sensitive: bool,
    pub regex: bool,
    pub root: Option<String>,
    /// 有未保存修改的打开文件：别动磁盘，回头自动保存会把替换结果盖掉
    pub skip: Vec<String>,
    /// 只统计不落盘
    pub dry_run: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Replaced {
    pub path: String,
    pub name: String,
    pub count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceReport {
    pub files: u32,
    pub replacements: u32,
    pub changed: Vec<Replaced>,
    pub skipped: Vec<Skipped>,
    pub dry_run: bool,
    /// 这次替换的快照 id；dryRun 或没能留底时为空（此时界面不显示「撤销」）
    pub snapshot: Option<String>,
    pub ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoReport {
    pub id: String,
    /// 快照建立的时间（秒）
    pub at: u64,
    pub pattern: String,
    pub replacement: String,
    pub files: u32,
    pub restored: Vec<Restored>,
    pub skipped: Vec<Skipped>,
    /// 盘上本来就是替换前内容的文件数（不用动，也不算失败）
    pub already: u32,
    pub ms: u64,
}

enum Matcher {
    Re(Regex),
    /// 普通文本：`$1` 就是字面上的三个字符，不按模板解释
    Lit { needle: String, ci: bool },
}

impl Matcher {
    fn build(pattern: &str, opts: &ReplaceOptions) -> Result<Self, String> {
        if pattern.is_empty() {
            return Err("查找内容不能为空".into());
        }
        if opts.regex {
            Ok(Matcher::Re(build_regex(pattern, opts.case_sensitive)?))
        } else {
            Ok(Matcher::Lit {
                needle: pattern.to_string(),
                ci: !opts.case_sensitive,
            })
        }
    }

    /// 返回（替换后的文本，替换处数）
    fn replace_all(&self, text: &str, with: &str) -> (String, u32) {
        match self {
            Matcher::Re(re) => {
                let count = re
                    .find_iter(text)
                    .filter(|m| m.end() > m.start())
                    .count() as u32;
                if count == 0 {
                    return (text.to_string(), 0);
                }
                // 正则模式下 with 走模板语义：$1 / ${name} 会展开
                (re.replace_all(text, with).into_owned(), count)
            }
            Matcher::Lit { needle, ci } => {
                if needle.is_empty() {
                    return (text.to_string(), 0);
                }
                let mut out = String::with_capacity(text.len());
                let mut count = 0u32;
                let mut at = 0usize;
                while at <= text.len() {
                    let Some(rel) = find_in(&text[at..], needle, !*ci) else { break };
                    let s = at + rel;
                    out.push_str(&text[at..s]);
                    out.push_str(with);
                    count += 1;
                    at = s + needle.len();
                }
                out.push_str(&text[at..]);
                (out, count)
            }
        }
    }
}

fn replace_impl(
    db: &Db,
    snap_dir: &Path,
    pattern: &str,
    replacement: &str,
    opts: &ReplaceOptions,
) -> Result<ReplaceReport, String> {
    let started = std::time::Instant::now();
    let matcher = Matcher::build(pattern, opts)?;
    let conn = db.lock().map_err(|e| e.to_string())?;

    // 目标文件来自索引：只处理文本文件，二进制 / 超大文件自然被挡在外面
    let targets: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare("SELECT path, root FROM docs WHERE (?1 IS NULL OR root = ?1)")
            .map_err(|e| format!("准备查询失败：{e}"))?;
        let rows = stmt
            .query_map(params![opts.root.as_deref()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| format!("查询失败：{e}"))?;
        rows.flatten().collect()
    };

    let skip: HashSet<&str> = opts.skip.iter().map(|s| s.as_str()).collect();
    let mut changed: Vec<Replaced> = Vec::new();
    let mut skipped: Vec<Skipped> = Vec::new();
    let mut replacements = 0u32;
    // 真要动盘才留底。建不起来（磁盘满 / 没权限）就照旧替换，只是这轮不能撤销
    let mut snap = if opts.dry_run {
        None
    } else {
        snapshot::Writer::new(snap_dir, pattern, replacement, opts.regex, opts.case_sensitive)
    };

    for (path, root) in targets {
        if skip.contains(path.as_str()) {
            skipped.push(Skipped {
                path,
                reason: "有未保存的修改".into(),
            });
            continue;
        }
        let p = PathBuf::from(&path);
        let Some((text, encoding, eol)) = fsx::read_text(&p, MAX_FILE) else {
            // 被删了 / 二进制 / 太大：不算错误，静默略过
            continue;
        };
        let (next, count) = matcher.replace_all(&text, replacement);
        if count == 0 {
            continue;
        }
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if !opts.dry_run {
            // 先留底再动手：写盘崩了也能把原件找回来
            let journaled = match snap.as_mut() {
                None => true,
                Some(w) => match fsx::text_bytes(&next, &encoding, &eol) {
                    Ok(after) => match std::fs::read(&p) {
                        Ok(before) => w.push(&path, &root, &name, &before, &after),
                        Err(_) => false,
                    },
                    Err(_) => false,
                },
            };
            if !journaled {
                // 留不了底就别改这个文件：撤销时漏掉它比不改更糟
                skipped.push(Skipped {
                    path,
                    reason: "无法记录撤销快照".into(),
                });
                continue;
            }

            if let Err(e) = fsx::write_text(&p, &next, &encoding, &eol) {
                if let Some(w) = snap.as_mut() {
                    w.drop_last();
                }
                skipped.push(Skipped { path, reason: e });
                continue;
            }
            // 替换完立刻重灌这一条，别让索引和磁盘对不上
            if let Err(e) = index_one(&conn, &root, &p) {
                eprintln!("替换后重灌索引 {path} 失败：{e}");
            }
        }

        replacements += count;
        changed.push(Replaced { name, path, count });
    }

    changed.sort_by(|a, b| a.path.cmp(&b.path));
    let snapshot = snap.and_then(|w| w.finish(snapshot::KEEP));

    Ok(ReplaceReport {
        files: changed.len() as u32,
        replacements,
        changed,
        skipped,
        dry_run: opts.dry_run,
        snapshot,
        ms: started.elapsed().as_millis() as u64,
    })
}

/* ------------------------------------------------------------------ */
/* 撤销全库替换                                                         */
/* ------------------------------------------------------------------ */

fn undo_impl(dir: &Path, db: &Db, id: Option<String>) -> Result<UndoReport, String> {
    let started = std::time::Instant::now();
    let id = match id {
        Some(id) => id,
        None => snapshot::latest(dir).ok_or_else(|| "还没有可撤销的替换".to_string())?,
    };
    let loaded = snapshot::load(dir, &id)?;
    // 只有「盘上还是替换后的样子」的文件才敢写回去，判断逻辑是纯函数
    let plan = snapshot::plan(&loaded, |p| std::fs::read(p).ok());

    let mut skipped: Vec<Skipped> = plan
        .skipped
        .into_iter()
        .map(|s| Skipped {
            path: s.path,
            reason: s.reason,
        })
        .collect();
    let mut restored: Vec<Restored> = Vec::new();
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        for i in plan.restore {
            let item = &loaded.items[i];
            let p = PathBuf::from(&item.path);
            match fsx::write_bytes(&p, &item.before) {
                Ok(()) => {
                    if let Err(e) = index_one(&conn, &item.root, &p) {
                        eprintln!("撤销后重灌索引 {} 失败：{e}", item.path);
                    }
                    restored.push(Restored {
                        path: item.path.clone(),
                        name: item.name.clone(),
                    });
                }
                Err(e) => skipped.push(Skipped {
                    path: item.path.clone(),
                    reason: e,
                }),
            }
        }
    }
    restored.sort_by(|a, b| a.path.cmp(&b.path));
    skipped.sort_by(|a, b| a.path.cmp(&b.path));

    // 撤完就把这份快照收起来：连按两次「撤销」应该退到更早的那次替换，
    // 而不是对着同一份快照原地打转
    snapshot::remove(dir, &id);

    Ok(UndoReport {
        id,
        at: loaded.manifest.at,
        pattern: loaded.manifest.pattern,
        replacement: loaded.manifest.replacement,
        files: restored.len() as u32,
        restored,
        skipped,
        already: plan.already,
        ms: started.elapsed().as_millis() as u64,
    })
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

/// 全库正则 / 文本替换。dryRun 时只统计不写盘，前端先拿数量去问用户
#[tauri::command]
pub async fn search_replace(
    state: State<'_, AppState>,
    pattern: String,
    replacement: String,
    options: Option<ReplaceOptions>,
) -> Result<ReplaceReport, String> {
    let db = state.search_db.clone();
    let snap_dir = state.snap_dir.clone();
    let opts = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        replace_impl(&db, &snap_dir, &pattern, &replacement, &opts)
    })
    .await
    .map_err(|e| format!("替换任务失败：{e}"))?
}

/// 撤销一次全库替换。不给 id 就撤最近那次；撤完这份快照就删掉，
/// 所以连按两次会一路退回更早的替换。
#[tauri::command]
pub async fn search_replace_undo(
    state: State<'_, AppState>,
    id: Option<String>,
) -> Result<UndoReport, String> {
    let db = state.search_db.clone();
    let snap_dir = state.snap_dir.clone();
    tauri::async_runtime::spawn_blocking(move || undo_impl(&snap_dir, &db, id))
        .await
        .map_err(|e| format!("撤销任务失败：{e}"))?
}

/// 单个文件重灌（保存、外部改动、改名之后调用）
#[tauri::command]
pub fn search_update(state: State<'_, AppState>, path: String, root: Option<String>) -> Result<(), String> {
    update_path(&state.search_db, &path, root)
}

/// `search_update` 的内部版本：标签改写、批量替换之后也要用
pub(crate) fn update_path(db: &Db, path: &str, root: Option<String>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let p = PathBuf::from(path);
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
        drop_exact(&conn, path)?;
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
