//! guest 胶水：由 `wit/plugin.wit` 生成，只在 wasm32 目标下参与编译。

wit_bindgen::generate!({
    path: "../../wit/plugin.wit",
    world: "plugin",
});

use exports::xnote::plugin::api::Guest;
use xnote::plugin::host;
use xnote::plugin::types::{Request, Response};

use crate::table::{render_table_with, rows_from_setting};

struct CsvViewer;

impl Guest for CsvViewer {
    /// 宿主带完整请求进来：目前和 render 同一条渲染路径。
    fn parse(req: Request) -> Response {
        host::log(0, &format!("csv-viewer: parse {}", req.path));
        ok(render_table_with(&req.content, max_rows()))
    }

    /// 只给内容，渲染成 HTML 表格。
    fn render(payload: String) -> Response {
        host::log(0, &format!("csv-viewer: render {} 字节", payload.len()));
        ok(render_table_with(&payload, max_rows()))
    }
}

/// 行数上限从宿主设置里读（`plugin-settings.json` 的 `maxRows`）。
/// 这条调用要求 `plugin.json` 的 `permissions` 里有 `read-setting`，
/// 否则宿主会拒掉整次运行——权限从清单里声明，不是插件自己说了算。
fn max_rows() -> usize {
    rows_from_setting(host::read_setting("maxRows").as_deref())
}

fn ok(html: String) -> Response {
    Response {
        ok: true,
        value: html,
        error: None,
    }
}

export!(CsvViewer);
