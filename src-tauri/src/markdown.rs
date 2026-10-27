//! Markdown 渲染：comrak（GFM）
//!
//! 只开 GFM 扩展，raw HTML 保持默认「转义」策略，前端再过一遍 DOMPurify。

use comrak::Options;

fn options() -> Options<'static> {
    let mut o = Options::default();
    // GFM 扩展：表格 / 任务列表 / 删除线 / 自动链接 / 脚注
    o.extension.table = true;
    o.extension.strikethrough = true;
    o.extension.tasklist = true;
    o.extension.autolink = true;
    o.extension.footnotes = true;
    // 代码块带上语言 class，前端好接高亮
    o.render.github_pre_lang = true;
    o
}

#[tauri::command]
pub fn md_render(markdown: String) -> String {
    comrak::markdown_to_html(&markdown, &options())
}
