//! 双链与标签：从全文索引的正文里解析 `[[双链]]` 与 `#标签`
//!
//! 只读不写——标签的落盘由前端走 `file_write`（拿缓冲区内容 + 原编码/换行写回），
//! 这样「改了标签但还没保存正文」时不会把正文改动冲掉。
//!
//! 解析规则和前端 `src/lib/links.ts` / `src/lib/tags.ts` 一一对应：
//! 代码块里的链接不算链接，`#编号` 不算标签，front-matter 的 tags 支持
//! `[a, b]`、`a, b`、`- a` 三种写法。

use crate::AppState;
use regex::Regex;
use rusqlite::params;
use serde::Serialize;
use std::sync::OnceLock;
use tauri::State;

/// 一张图最多装多少个文件（再多的仓库该用专门的工具）
const MAX_NODES: usize = 5000;
/// 只扫正文前 20 万个字符，链接和标签基本都在前面
const SCAN_CHARS: usize = 200_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GLink {
    pub target: String,
    pub label: String,
    /// "wiki" | "md"
    pub kind: String,
    /// 1 起算的行号
    pub line: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GNode {
    pub path: String,
    pub name: String,
    pub title: String,
    pub tags: Vec<String>,
    pub links: Vec<GLink>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub nodes: Vec<GNode>,
    pub took: u64,
}

/* ------------------------------------------------------------------ */
/* 掩码：代码位置换成等长空格，字节偏移与行号都不变                       */
/* ------------------------------------------------------------------ */

fn mask_inline(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = vec![b' '; bytes.len()];
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let mut n = 1;
            while i + n < bytes.len() && bytes[i + n] == b'`' {
                n += 1;
            }
            // 找等长的收尾反引号串；找不到就当成普通字符
            let mut j = i + n;
            let mut closed = None;
            while j < bytes.len() {
                if bytes[j] == b'`' {
                    let mut k = 0;
                    while j + k < bytes.len() && bytes[j + k] == b'`' {
                        k += 1;
                    }
                    if k == n {
                        closed = Some(j + k);
                        break;
                    }
                    j += k;
                } else {
                    j += 1;
                }
            }
            if let Some(end) = closed {
                i = end;
                continue;
            }
        }
        out[i] = bytes[i];
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn fence_marker(s: &str) -> Option<(char, usize)> {
    let ch = s.chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let n = s.chars().take_while(|c| *c == ch).count();
    if n >= 3 {
        Some((ch, n))
    } else {
        None
    }
}

fn mask_code(text: &str) -> String {
    let mut fence: Option<(char, usize)> = None;
    let mut out = String::with_capacity(text.len());
    for (idx, line) in text.split('\n').enumerate() {
        if idx > 0 {
            out.push('\n');
        }
        let open = fence_marker(line.trim_start());
        match fence {
            Some((ch, n)) => {
                if let Some((c2, n2)) = open {
                    if c2 == ch && n2 >= n {
                        fence = None;
                    }
                }
                out.push_str(&" ".repeat(line.len()));
            }
            None => match open {
                Some(m) => {
                    fence = Some(m);
                    out.push_str(&" ".repeat(line.len()));
                }
                None => out.push_str(&mask_inline(line)),
            },
        }
    }
    out
}

fn line_at(text: &str, offset: usize) -> u32 {
    text.as_bytes()[..offset.min(text.len())]
        .iter()
        .filter(|b| **b == b'\n')
        .count() as u32
        + 1
}

/* ------------------------------------------------------------------ */
/* front-matter                                                         */
/* ------------------------------------------------------------------ */

struct Split<'a> {
    body: Option<&'a str>,
    rest: &'a str,
}

fn split_front_matter(text: &str) -> Split<'_> {
    let Some(first_nl) = text.find('\n') else {
        return Split { body: None, rest: text };
    };
    if text[..first_nl].trim() != "---" {
        return Split { body: None, rest: text };
    }
    let mut pos = first_nl + 1;
    while pos <= text.len() {
        let (line_end, next) = match text[pos..].find('\n') {
            Some(i) => (pos + i, pos + i + 1),
            None => (text.len(), text.len()),
        };
        if text[pos..line_end].trim() == "---" {
            return Split {
                body: Some(&text[first_nl + 1..pos]),
                rest: &text[next..],
            };
        }
        if next >= text.len() {
            break;
        }
        pos = next;
    }
    Split { body: None, rest: text }
}

fn re_tags_key() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*tags?\s*:\s*(.*)$").unwrap())
}

fn re_block_item() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*-\s+(.+)$").unwrap())
}

fn strip_quotes(s: &str) -> String {
    let t = s.trim();
    let bytes = t.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0] as char;
        if (first == '"' || first == '\'') && t.chars().last() == Some(first) {
            return t[1..t.len() - 1].to_string();
        }
    }
    t.to_string()
}

fn tags_from_yaml(body: &str) -> Vec<String> {
    let lines: Vec<&str> = body.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let Some(cap) = re_tags_key().captures(lines[i]) else {
            i += 1;
            continue;
        };
        let inline = cap[1].trim().to_string();
        if !inline.is_empty() {
            let inner = inline.trim_start_matches('[').trim_end_matches(']');
            for part in inner.split(',') {
                out.push(strip_quotes(part));
            }
        } else {
            let mut j = i + 1;
            while j < lines.len() {
                if let Some(item) = re_block_item().captures(lines[j]) {
                    out.push(strip_quotes(&item[1]));
                } else if !lines[j].trim().is_empty() {
                    break;
                }
                j += 1;
            }
        }
        i += 1;
    }
    out
}

/* ------------------------------------------------------------------ */
/* 标签规范化（与前端 cleanTag 一致）                                    */
/* ------------------------------------------------------------------ */

fn clean_tag(raw: &str) -> String {
    let stripped: String = raw
        .trim()
        .trim_start_matches('#')
        .chars()
        .filter(|c| !matches!(c, ',' | '[' | ']' | '{' | '}' | '#'))
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .collect();
    stripped.chars().take(40).collect()
}

fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let v = clean_tag(t);
        if v.is_empty() {
            continue;
        }
        let key = v.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(v);
    }
    out
}

fn re_tag() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)(^|[\s\p{P}])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]{0,39})").unwrap()
    })
}

fn re_digits() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\d+$").unwrap())
}

/// 全文标签：front-matter 的 + 正文 `#标签`
fn parse_tags(text: &str) -> Vec<String> {
    let split = split_front_matter(text);
    let mut raw: Vec<String> = Vec::new();
    if let Some(body) = split.body {
        raw.extend(tags_from_yaml(body));
    }
    let masked = mask_code(text);
    // front-matter 部分蒙掉，免得 `url: http://x/#sec` 被当成标签
    let body_start = text.len() - split.rest.len();
    let head: String = masked[..body_start]
        .chars()
        .map(|c| if c == '\n' { '\n' } else { ' ' })
        .collect();
    let scan = head + &masked[body_start..];
    for cap in re_tag().captures_iter(&scan) {
        let tag = &cap[2];
        if re_digits().is_match(tag) {
            continue;
        }
        raw.push(tag.to_string());
    }
    normalize_tags(&raw)
}

/* ------------------------------------------------------------------ */
/* 链接                                                                 */
/* ------------------------------------------------------------------ */

fn re_wiki() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\[\]\n]+)\]\]").unwrap())
}

fn re_md() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(!?)\[([^\]\n]*)\]\(([^)\s]+?)\)").unwrap())
}

fn re_scheme() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:").unwrap())
}

fn re_md_href() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.md(#.*)?$").unwrap())
}

/// `notes/想法.md#标题` → `notes/想法`
fn normalize_target(raw: &str) -> String {
    let mut t = raw.trim().to_string();
    if let Some(i) = t.find('#') {
        t.truncate(i);
    }
    t = t.replace('\\', "/");
    if let Some(rest) = t.strip_prefix("./") {
        t = rest.to_string();
    }
    if t.to_lowercase().ends_with(".md") {
        let cut = t.len() - 3;
        t.truncate(cut);
    }
    t.trim().to_string()
}

fn parse_links(text: &str) -> Vec<GLink> {
    let masked = mask_code(text);
    let mut out: Vec<GLink> = Vec::new();

    for cap in re_wiki().captures_iter(&masked) {
        let m = cap.get(0).unwrap();
        let inner = &text[m.start() + 2..m.end() - 2];
        let (raw_target, alias) = match inner.find('|') {
            Some(i) => (&inner[..i], inner[i + 1..].trim()),
            None => (inner, ""),
        };
        let target = normalize_target(raw_target);
        if target.is_empty() {
            continue;
        }
        out.push(GLink {
            label: if alias.is_empty() {
                raw_target.trim().to_string()
            } else {
                alias.to_string()
            },
            target,
            kind: "wiki".to_string(),
            line: line_at(text, m.start()),
        });
    }

    for cap in re_md().captures_iter(&masked) {
        if !cap[1].is_empty() {
            continue; // 图片不算引用
        }
        let href = &cap[3];
        if re_scheme().is_match(href) || href.starts_with('#') || href.starts_with('/') {
            continue;
        }
        if !re_md_href().is_match(href) {
            continue;
        }
        let target = normalize_target(href);
        if target.is_empty() {
            continue;
        }
        let m = cap.get(0).unwrap();
        let label = cap[2].trim().to_string();
        out.push(GLink {
            label: if label.is_empty() { target.clone() } else { label },
            target,
            kind: "md".to_string(),
            line: line_at(text, m.start()),
        });
    }

    out.sort_by_key(|l| l.line);
    out
}

/* ------------------------------------------------------------------ */
/* 节点                                                                 */
/* ------------------------------------------------------------------ */

fn re_title_key() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s*title\s*:\s*(.+)$").unwrap())
}

fn re_heading() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^#{1,6}[ \t]+(.+)$").unwrap())
}

fn title_of(text: &str, name: &str) -> String {
    if let Some(body) = split_front_matter(text).body {
        if let Some(cap) = re_title_key().captures(body) {
            let v = strip_quotes(&cap[1]);
            if !v.is_empty() {
                return v;
            }
        }
    }
    if let Some(cap) = re_heading().captures(text) {
        return cap[1].trim().to_string();
    }
    name.trim_end_matches(".md").to_string()
}

fn name_of(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

fn node_of(path: &str, body: &str) -> GNode {
    let name = name_of(path);
    GNode {
        path: path.to_string(),
        title: title_of(body, &name),
        tags: parse_tags(body),
        links: parse_links(body),
        name,
    }
}

fn clip(text: &str) -> &str {
    match text.char_indices().nth(SCAN_CHARS) {
        Some((i, _)) => &text[..i],
        None => text,
    }
}

/* ------------------------------------------------------------------ */
/* 命令                                                                 */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn graph_scan(state: State<'_, AppState>, root: String) -> Result<Graph, String> {
    let t0 = std::time::Instant::now();

    // 先把正文捞出来再放锁：解析几百篇要几十毫秒，不该卡住搜索
    let rows: Vec<(String, String)> = {
        let conn = state.search_db.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT path, body FROM docs WHERE root = ?1 ORDER BY path")
            .map_err(|e| e.to_string())?;
        let iter = stmt
            .query_map(params![&root], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        iter.take(MAX_NODES)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    let nodes = rows
        .iter()
        .map(|(path, body)| node_of(path, clip(body)))
        .collect();

    Ok(Graph {
        nodes,
        took: t0.elapsed().as_millis() as u64,
    })
}
