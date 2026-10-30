//! CSV / TSV → HTML 表格。纯逻辑，不依赖宿主，可以在本机直接跑测试。

/// 默认最多渲染这么多行数据（表头另算）
pub const DEFAULT_MAX_ROWS: usize = 500;
/// 用户在 `plugin-settings.json` 里把 `maxRows` 调大也不能超过这个数
pub const MAX_ROWS_LIMIT: usize = 5000;

/// 把 `read-setting` 里那条字符串翻成行数上限：没设 / 不是数字就用默认值
pub fn rows_from_setting(raw: Option<&str>) -> usize {
    raw.and_then(|v| v.trim().parse::<usize>().ok())
        .map(|n| n.clamp(1, MAX_ROWS_LIMIT))
        .unwrap_or(DEFAULT_MAX_ROWS)
}

/// 把 CSV / TSV 渲染成 HTML 表格（最多 500 行数据）。
pub fn render_table(source: &str) -> String {
    render_table_with(source, DEFAULT_MAX_ROWS)
}

/// 同上，行数上限由调用方给
pub fn render_table_with(source: &str, max_rows: usize) -> String {
    let mut rows = source.lines().filter(|l| !l.trim().is_empty());
    let Some(header) = rows.next() else {
        return "<p>（空文件）</p>".to_string();
    };
    let sep = if header.contains('\t') { '\t' } else { ',' };

    let mut html = String::from("<table><thead><tr>");
    for cell in header.split(sep) {
        html.push_str("<th>");
        html.push_str(&escape_html(cell.trim_matches('"')));
        html.push_str("</th>");
    }
    html.push_str("</tr></thead><tbody>");
    for row in rows.take(max_rows) {
        html.push_str("<tr>");
        for cell in row.split(sep) {
            html.push_str("<td>");
            html.push_str(&escape_html(cell.trim_matches('"')));
            html.push_str("</td>");
        }
        html.push_str("</tr>");
    }
    html.push_str("</tbody></table>");
    html
}

pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_header_and_rows() {
        let html = render_table("a,b\n1,2\n3,4\n");
        assert!(html.contains("<th>a</th>"));
        assert!(html.contains("<td>4</td>"));
    }

    #[test]
    fn picks_separator_from_header() {
        let html = render_table("a\tb\n1\t2\n");
        assert!(html.contains("<th>b</th>"));
        assert!(html.contains("<td>2</td>"));
    }

    #[test]
    fn strips_quotes_and_skips_blank_lines() {
        let html = render_table("\"a\",\"b\"\n\n\"1\",\"2\"\n");
        assert!(html.contains("<th>a</th>"));
        assert!(html.contains("<td>1</td>"));
    }

    #[test]
    fn empty_input() {
        assert_eq!(render_table(""), "<p>（空文件）</p>");
    }

    #[test]
    fn escapes_html() {
        assert_eq!(escape_html("<script>"), "&lt;script&gt;");
        assert!(render_table("a\n<script>x</script>\n").contains("&lt;script&gt;"));
    }

    #[test]
    fn caps_rows_at_500() {
        let mut src = String::from("h\n");
        for i in 0..600 {
            src.push_str(&format!("{i}\n"));
        }
        assert_eq!(render_table(&src).matches("<tr>").count(), 501);
    }

    #[test]
    fn respects_explicit_limit() {
        let mut src = String::from("h\n");
        for i in 0..20 {
            src.push_str(&format!("{i}\n"));
        }
        assert_eq!(render_table_with(&src, 3).matches("<tr>").count(), 4);
    }

    #[test]
    fn reads_limit_from_setting() {
        assert_eq!(rows_from_setting(None), DEFAULT_MAX_ROWS);
        assert_eq!(rows_from_setting(Some(" 12 ")), 12);
        // 乱填就退回默认值，别让插件崩在解析上
        assert_eq!(rows_from_setting(Some("很多")), DEFAULT_MAX_ROWS);
        assert_eq!(rows_from_setting(Some("0")), 1);
        assert_eq!(rows_from_setting(Some("999999")), MAX_ROWS_LIMIT);
    }
}
