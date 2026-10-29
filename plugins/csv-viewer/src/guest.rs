//! guest 胶水：由 `wit/plugin.wit` 生成，只在 wasm32 目标下参与编译。

wit_bindgen::generate!({
    path: "../../wit/plugin.wit",
    world: "plugin",
});

use exports::xnote::plugin::api::Guest;
use xnote::plugin::host;
use xnote::plugin::types::{Request, Response};

use crate::table::render_table;

struct CsvViewer;

impl Guest for CsvViewer {
    /// 宿主带完整请求进来：目前和 render 同一条渲染路径。
    fn parse(req: Request) -> Response {
        host::log(0, &format!("csv-viewer: parse {}", req.path));
        ok(render_table(&req.content))
    }

    /// 只给内容，渲染成 HTML 表格。
    fn render(payload: String) -> Response {
        host::log(0, &format!("csv-viewer: render {} 字节", payload.len()));
        ok(render_table(&payload))
    }
}

fn ok(html: String) -> Response {
    Response {
        ok: true,
        value: html,
        error: None,
    }
}

export!(CsvViewer);
