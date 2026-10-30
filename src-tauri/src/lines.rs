//! 把「全文里的命中区间」折成「一行一条」的上下文。
//!
//! 以前每个文件只给一段摘要：想看看别处怎么写的，得先打开文件再自己找一遍。
//! 这里把命中按行归拢——一行一条，带行号和这一行的原文，点哪条跳哪条。
//!
//! 相邻的命中不拆成两段：中间只隔一两行时，那几行也当上下文带上（`hit = false`），
//! 于是「连续的行号」就等于「同一段」。前端不用另传分组信息，顺着行号连不连续切段即可。
//!
//! 纯逻辑：文本 + 绝对字节区间进来，行窗口出去。不碰索引、不碰文件，
//! 所以在测试里可以直接拿字符串断言（跨行、多行同一处、缩进、超长行都不用起环境）。

/// 一条行窗口：命中行，或两块命中之间补的上下文行
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineHit {
    /// 1 起算
    pub line: u32,
    /// 1 起算，按字符数（上下文行固定 1）
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
    /// 这一行本身有命中；`false` 是两块命中之间补的上下文
    pub hit: bool,
}

/// 一行最多带多少字符的上下文。压缩过的 JS / JSON 一行能有几十万字符，
/// 原样塞进搜索结果就是几十 MB 的 payload
const LINE_MAX: usize = 240;
/// 截断时命中处前面留多少字符
const LINE_HEAD: usize = 60;
/// 两个命中行相差不到这么多行就合成一段，中间的行补成上下文。
/// 3 表示最多补 2 行——再多就只给「⋯ 跳过 N 行」而不是把整段正文搬过来
pub const MERGE_GAP: usize = 3;

/// `ranges` 是全文里的绝对区间（可以乱序、可以重叠、可以跨行）；
/// `max` 是最多返回多少**命中行**（0 表示不要上下文，直接返回空，省一次扫描）。
/// 第二个返回值是「有命中的总行数」，可能大于 `max`。
///
/// 返回的窗口按行号升序、连续的行号属于同一段；`hit = false` 的是补进来的上下文行。
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
    // 已经建了窗口的命中行数（上下文行不算，否则 max 会被它们吃光）
    let mut built = 0usize;
    // 上一段区间落在哪一行。超过 max 之后不再建窗口，但「哪一行算过了」
    // 必须照样记着，否则同一行的后几处命中会被数成好几行
    let mut seen: usize = usize::MAX;
    // 最后一个进来的行（命中或上下文），用来判断下一处命中离得远不远
    let mut last_idx: Option<usize> = None;
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
                if last.hit && last.line as usize == idx + 1 {
                    push_range(last, s, end);
                }
            }
            continue;
        }
        seen = idx;
        total_lines += 1;
        if built >= max {
            continue;
        }
        built += 1;

        // 跟上一行隔得近就把中间几行补成上下文，两处命中在界面上连成一段
        if let Some(prev) = last_idx {
            let gap = idx.saturating_sub(prev + 1);
            if gap > 0 && gap < MERGE_GAP {
                for k in 1..=gap {
                    push_context(&mut lines, text, &starts, prev + k);
                }
            }
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
            hit: true,
        };
        push_range(&mut hit, s, end);
        lines.push(hit);
        last_idx = Some(idx);
    }

    // column 要等行窗口定下来再算：缩进被吃掉了，字符数才对得上
    for hit in &mut lines {
        if let Some((s, _)) = hit.ranges.first() {
            hit.column = text[hit.start..hit.start + s].chars().count() as u32 + 1;
        }
    }

    (lines, total_lines)
}

/// 补一行上下文：没有高亮区间，超长就从行首截断
fn push_context(lines: &mut Vec<LineHit>, text: &str, starts: &[usize], idx: usize) {
    let line_start = starts[idx];
    let line_end = starts
        .get(idx + 1)
        .map(|next| next.saturating_sub(1))
        .unwrap_or(text.len());
    let (ts, te) = trim_bounds(text, line_start, line_end);
    let (ws, we, cut_before, cut_after) = clip_plain(text, ts, te);
    lines.push(LineHit {
        line: (idx + 1) as u32,
        column: 1,
        start: ws,
        end: we,
        ranges: Vec::new(),
        cut_before,
        cut_after,
        hit: false,
    });
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

/// 上下文行的截断：没有锚点，就从行首留 `LINE_MAX` 个字符
fn clip_plain(text: &str, ts: usize, te: usize) -> (usize, usize, bool, bool) {
    let mut end = ts;
    let mut n = 0usize;
    for (i, c) in text[ts..te].char_indices() {
        if n >= LINE_MAX {
            break;
        }
        end = ts + i + c.len_utf8();
        n += 1;
    }
    (ts, end, false, end < te)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 「笔记」在全文里的所有区间，够测试用了（不做词边界，中文按字走）
    fn hits(text: &str, needle: &str) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        let mut at = 0;
        while let Some(i) = text[at..].find(needle) {
            let s = at + i;
            out.push((s, s + needle.len()));
            at = s + needle.len();
        }
        out
    }

    fn lines_of(text: &str, max: usize) -> (Vec<u32>, Vec<bool>) {
        let (lines, _) = group(text, &hits(text, "笔记"), max);
        (
            lines.iter().map(|l| l.line).collect(),
            lines.iter().map(|l| l.hit).collect(),
        )
    }

    #[test]
    fn adjacent_hits_stay_separate_rows() {
        // 第 1、2 行都命中：中间没有空行，不需要补上下文
        let text = "第一行 笔记\n第二行 笔记\n第三行\n";
        let (nos, flags) = lines_of(text, 20);
        assert_eq!(nos, [1, 2]);
        assert!(flags.iter().all(|f| *f));
    }

    #[test]
    fn nearby_hits_fill_context_between_them() {
        // 第 1 行和第 3 行之间隔着一行：补成 1/2/3，视觉上连成一段
        let text = "第一行 笔记\n中间这行没有\n第三行 笔记\n第四行\n";
        let (lines, total) = group(text, &hits(text, "笔记"), 20);
        assert_eq!(total, 2);
        let nos: Vec<u32> = lines.iter().map(|l| l.line).collect();
        assert_eq!(nos, [1, 2, 3]);
        let flags: Vec<bool> = lines.iter().map(|l| l.hit).collect();
        assert_eq!(flags, [true, false, true]);

        // 上下文行带自己的正文，但没有高亮、列号固定 1
        let mid = &lines[1];
        let body = &text[mid.start..mid.end];
        assert_eq!(body, "中间这行没有");
        assert!(mid.ranges.is_empty());
        assert_eq!(mid.column, 1);
    }

    #[test]
    fn gap_wider_than_limit_starts_a_new_block() {
        // 中间隔 4 行（超过 MERGE_GAP 允许的 2 行）就断开，不搬家
        let text = "笔记一\nb\nc\nd\ne\n笔记二\n";
        let (nos, flags) = lines_of(text, 20);
        assert_eq!(nos, [1, 6]);
        assert!(flags.iter().all(|f| *f));
    }

    #[test]
    fn blank_line_counts_as_context() {
        // 空行也算一行上下文：段落之间空一行，两段正文还能连在一起
        let text = "笔记一\n\n笔记二\n";
        let (nos, flags) = lines_of(text, 20);
        assert_eq!(nos, [1, 2, 3]);
        assert_eq!(flags, [true, false, true]);
    }

    #[test]
    fn max_counts_hit_lines_only() {
        // 补进来的上下文行不能吃配额：max = 2 时仍要拿到两处命中
        let text = "笔记一\n中间\n笔记二\n";
        let (lines, total) = group(text, &hits(text, "笔记"), 2);
        assert_eq!(total, 2);
        let flags: Vec<bool> = lines.iter().map(|l| l.hit).collect();
        assert_eq!(flags, [true, false, true]);
    }

    #[test]
    fn columns_are_chars_not_bytes() {
        let text = "    第二行 笔记\n";
        let (lines, _) = group(text, &hits(text, "笔记"), 20);
        // 缩进被吃掉，正文从第 1 个字开始；「第二行 」占 4 个字，命中在第 5 列
        assert_eq!(lines[0].column, 5);
    }

    #[test]
    fn long_context_line_is_clipped_at_head() {
        let long = "x".repeat(400);
        let text = format!("笔记一\n{long}\n笔记三\n");
        let (lines, _) = group(&text, &hits(&text, "笔记"), 20);
        let mid = &lines[1];
        assert!(!mid.hit);
        assert!(!mid.cut_before);
        assert!(mid.cut_after);
        assert_eq!(mid.end - mid.start, 240);
    }

    #[test]
    fn empty_inputs_are_fine() {
        assert_eq!(group("", &[], 20), (Vec::new(), 0));
        assert_eq!(group("笔记", &hits("笔记", "笔记"), 0).0.len(), 0);
    }
}
