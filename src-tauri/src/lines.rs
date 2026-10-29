//! 把「全文里的命中区间」折成「一行一条」的上下文。
//!
//! 以前每个文件只给一段摘要：想看看别处怎么写的，得先打开文件再自己找一遍。
//! 这里把命中按行归拢——一行一条，带行号和这一行的原文，点哪条跳哪条。
//!
//! 纯逻辑：文本 + 绝对字节区间进来，行窗口出去。不碰索引、不碰文件，
//! 所以在测试里可以直接拿字符串断言（跨行、多行同一处、缩进、超长行都不用起环境）。

/// 一行命中：行号 + 行首尾（去掉缩进后）在全文里的字节偏移 + 行内相对区间
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineHit {
    /// 1 起算
    pub line: u32,
    /// 1 起算，按字符数
    pub column: u32,
    /// 行首（已去掉缩进）在全文里的字节偏移
    pub start: usize,
    /// 行尾（已去掉行尾空白）的字节偏移，不含换行符
    pub end: usize,
    /// 相对 `start` 的高亮区间
    pub ranges: Vec<(usize, usize)>,
    /// 行太长被截了开头 / 结尾（界面上要补「…」）
    pub cut_before: bool,
    pub cut_after: bool,
}

/// 一行最多带多少字符的上下文。压缩过的 JS / JSON 一行能有几十万字符，
/// 原样塞进搜索结果就是几十 MB 的 payload
const LINE_MAX: usize = 240;
/// 截断时命中处前面留多少字符
const LINE_HEAD: usize = 60;

/// `ranges` 是全文里的绝对区间（可以乱序、可以重叠、可以跨行）；
/// `max` 是最多返回多少行（0 表示不要上下文，直接返回空，省一次扫描）。
/// 第二个返回值是「有命中的总行数」，可能大于 `max`。
pub fn group(text: &str, ranges: &[(usize, usize)], max: usize) -> (Vec<LineHit>, u32) {
    if ranges.is_empty() || max == 0 || text.is_empty() {
        return (Vec::new(), 0);
    }

    // 行首偏移表：一次扫描，后面二分查找
    let mut starts: Vec<usize> = Vec::with_capacity(64);
    starts.push(0);
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            starts.push(i + 1);
        }
    }

    let mut sorted: Vec<(usize, usize)> = ranges
        .iter()
        .copied()
        .filter(|(s, e)| e > s && *s < text.len())
        .collect();
    sorted.sort_unstable();

    let mut lines: Vec<LineHit> = Vec::new();
    let mut total_lines = 0u32;
    // 上一段区间落在哪一行。超过 max 之后不再建窗口，但「哪一行算过了」
    // 必须照样记着，否则同一行的后几处命中会被数成好几行
    let mut seen: usize = usize::MAX;
    for (s, e) in sorted {
        let idx = starts.partition_point(|&x| x <= s).saturating_sub(1);
        let line_start = starts[idx];
        let line_end = starts
            .get(idx + 1)
            .map(|next| next.saturating_sub(1))
            .unwrap_or(text.len());
        // 跨行的命中在本行里截断（剩下那截属于下一行）
        let end = e.min(line_end);
        if end <= line_start {
            continue;
        }

        if seen == idx {
            // 同一行的后一处命中：并进上一条（超过 max 时上一条可能已经不在）
            if let Some(last) = lines.last_mut() {
                if last.line as usize == idx + 1 {
                    push_range(last, s, end);
                }
            }
            continue;
        }
        seen = idx;
        total_lines += 1;
        if lines.len() >= max {
            continue;
        }
        let (ts, te) = trim_bounds(text, line_start, line_end);
        let (ws, we, cut_before, cut_after) = clip_line(text, ts, te, s);
        let mut hit = LineHit {
            line: (idx + 1) as u32,
            column: 1,
            start: ws,
            end: we,
            ranges: Vec::new(),
            cut_before,
            cut_after,
        };
        push_range(&mut hit, s, end);
        lines.push(hit);
    }

    // column 要等行窗口定下来再算：缩进被吃掉了，字符数才对得上
    for hit in &mut lines {
        if let Some((s, _)) = hit.ranges.first() {
            hit.column = text[hit.start..hit.start + s].chars().count() as u32 + 1;
        }
    }

    (lines, total_lines)
}

/// 行首去掉缩进、行尾去掉空白。全空行就用原样，免得区间越界
fn trim_bounds(text: &str, line_start: usize, line_end: usize) -> (usize, usize) {
    let raw = &text[line_start..line_end];
    let lead = raw.len() - raw.trim_start_matches([' ', '\t']).len();
    let tail = raw.trim_end_matches([' ', '\t', '\r']).len().max(lead);
    (line_start + lead, line_start + tail)
}

/// 往行窗口里加一段区间：先夹到行窗口，再换算成相对偏移
fn push_range(hit: &mut LineHit, s: usize, e: usize) {
    let start = s.max(hit.start);
    let end = e.min(hit.end);
    if end <= start {
        return;
    }
    hit.ranges.push((start - hit.start, end - hit.start));
}

/// 超长行按字符截一段（命中处前面留一点，别把词切掉）。
/// 返回（窗口起、窗口止、前面截了没、后面截了没）。
fn clip_line(text: &str, ts: usize, te: usize, anchor: usize) -> (usize, usize, bool, bool) {
    let line = &text[ts..te];
    let total = line.chars().count();
    if total <= LINE_MAX {
        return (ts, te, false, false);
    }

    // 命中处前面留 LINE_HEAD 个字符
    let anchor = anchor.clamp(ts, te);
    let mut start = anchor;
    let mut back = 0usize;
    for (i, _) in text[ts..anchor].char_indices().rev() {
        if back >= LINE_HEAD {
            break;
        }
        start = ts + i;
        back += 1;
    }

    let mut end = start;
    let mut fwd = 0usize;
    for (i, c) in text[start..te].char_indices() {
        end = start + i + c.len_utf8();
        fwd += 1;
        if fwd >= LINE_MAX {
            break;
        }
    }

    (start, end, start > ts, end < te)
}
