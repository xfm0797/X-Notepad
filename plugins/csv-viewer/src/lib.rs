//! CSV 查看器 —— X-Notepad WASM 插件示例
//!
//! 导出（ABI v1）：`alloc` / `run` / `result_len`
//! 导入（模块 `xnote`）：`log`
//!
//! 构建：
//! ```bash
//! rustup target add wasm32-unknown-unknown
//! cargo build --release --target wasm32-unknown-unknown
//! cp target/wasm32-unknown-unknown/release/csv_viewer.wasm ./plugin.wasm
//! ```

use std::cell::RefCell;

thread_local! {
    /// 上一次 run 的结果（UTF-8 JSON），指针返回给宿主
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[link(wasm_import_module = "xnote")]
extern "C" {
    fn log(level: i32, ptr: i32, len: i32);
}

fn host_log(level: i32, message: &str) {
    // 只在 wasm 目标下真正调用；本地跑测试时没有这个导入
    #[cfg(target_arch = "wasm32")]
    unsafe {
        log(level, message.as_ptr() as i32, message.len() as i32);
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (level, message);
    }
}

/// 宿主调用：申请 len 字节的输入缓冲区
#[no_mangle]
pub extern "C" fn alloc(len: i32) -> i32 {
    let len = if len < 0 { 0 } else { len as usize };
    let mut buf: Vec<u8> = Vec::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr as i32
}

/// 上一次 run 的结果字节数
#[no_mangle]
pub extern "C" fn result_len() -> i32 {
    RESULT.with(|r| r.borrow().len() as i32)
}

/// 执行入口：ptr/len 是宿主写入的输入 JSON，返回结果 JSON 的首地址
#[no_mangle]
pub extern "C" fn run(ptr: i32, len: i32) -> i32 {
    let len = if len < 0 { 0 } else { len as usize };
    let input = unsafe { std::slice::from_raw_parts(ptr as *const u8, len) };
    let request = String::from_utf8_lossy(input).to_string();

    host_log(0, "csv-viewer: 收到请求");

    let content = extract_string(&request, "content").unwrap_or_default();
    let html = render_table(&content);
    let payload = format!(
        "{{\"ok\":true,\"value\":{},\"error\":null}}",
        json_string(&html)
    );

    RESULT.with(|slot| {
        let mut buf = slot.borrow_mut();
        *buf = payload.into_bytes();
        buf.as_ptr() as i32
    })
}

/* ---------------- CSV → HTML ---------------- */

fn render_table(source: &str) -> String {
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
    for row in rows.take(500) {
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

fn escape_html(s: &str) -> String {
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

/* ---------------- 极简 JSON 处理 ---------------- */

/// 从 JSON 里取一个字符串字段（只处理本协议用得到的形状）
pub fn extract_string(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let start = json.find(&needle)?;
    let rest = &json[start + needle.len()..];
    let colon = rest.find(':')?;
    let rest = rest[colon + 1..].trim_start();
    let mut chars = rest.char_indices();
    let (_, first) = chars.next()?;
    if first != '"' {
        return None;
    }
    let mut out = String::new();
    let mut escaped = false;
    for (idx, ch) in chars {
        if escaped {
            match ch {
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                '/' => out.push('/'),
                'u' => { /* 简化处理：代理对不展开 */ }
                other => out.push(other),
            }
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            let _ = idx;
            return Some(out);
        } else {
            out.push(ch);
        }
    }
    Some(out)
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/* ---------------- 本机单测（cargo test） ---------------- */

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
    fn escapes_html() {
        assert_eq!(escape_html("<script>"), "&lt;script&gt;");
    }

    #[test]
    fn extracts_content_field() {
        let json = r#"{"action":"render","path":"/a.csv","content":"x,y\n1,2"}"#;
        assert_eq!(extract_string(json, "content").as_deref(), Some("x,y\n1,2"));
    }

    #[test]
    fn extracts_escaped_content() {
        let json = r#"{"content":"line1\nline2"}"#;
        assert_eq!(extract_string(json, "content").as_deref(), Some("line1\nline2"));
    }

    #[test]
    fn json_roundtrip() {
        let encoded = json_string("a\"b\nc");
        assert_eq!(encoded, "\"a\\\"b\\nc\"");
    }
}
