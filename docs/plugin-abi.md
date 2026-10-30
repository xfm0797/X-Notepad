# 插件 ABI

X-Notepad 的插件跑在 wasmtime 沙箱里，宿主按 **wasm 文件头**自动分流两代 ABI：

| 文件头 | ABI | 形态 | 状态 |
| --- | --- | --- | --- |
| `00 61 73 6d 0d 00 01 00` | v2 | 组件（Component Model） | 当前 |
| `00 61 73 6d 01 00 00 00` | v1 | 核心模块（手写指针协议） | 兼容保留 |

> v1 是什么：0.1.0 时插件是普通 `wasm32` 模块，导出 `alloc` / `run` / `result_len`，
> 靠线性内存传一段 JSON。0.11.0 起新插件请用 v2；已经装在用户机器上的 v1 插件
> 不用重写，宿主照旧能跑（`src-tauri/src/plugin_abi.rs` 负责判断）。

## v2：组件

接口定义在 [`wit/plugin.wit`](../wit/plugin.wit)，一句话：

```wit
world plugin {
  import host;   // log(level, message) / now-ms() / read-setting(key)
  export api;    // parse(request) -> response / render(payload) -> response
}
```

插件**只能**看到 `host` 那三个函数，拿不到文件系统、网络、环境变量。要加能力，
先在 WIT 里写一条显式导入，宿主再决定给不给。

### 权限（permissions）

能看见接口不等于能用。**默认一件都不给**，插件得在 `plugin.json` 的 `permissions`
里显式列出来，宿主的每个 host 函数进来先查一遍这份清单：

| 能力键 | 对应 | 被拒时插件看到什么 |
| --- | --- | --- |
| `log` | `host.log` | 这条日志直接丢掉 |
| `now-ms` | `host.now-ms` | 返回 `0` |
| `read-setting` | `host.read-setting` | 永远返回 `none` |

只要这次运行里发生过一次越权调用，**整次调用就算失败**，并把缺哪个能力写进报错：

```
插件调用了没声明的能力：read-setting（在 plugin.json 的 permissions 里补上再重装）
```

这么设计是因为插件作者自己写清单：清单没声明却在调，要么是漏写、要么是它压根没打算
老实交代——两种都不该悄悄给个空结果糊过去。

缺省规则分两代，别记混：

| 清单 | v2（组件） | v1（核心模块） |
| --- | --- | --- |
| 没有 `permissions` 字段 | 什么都不给 | 给 `log` + `now-ms`（历史行为，免得老插件突然跑不了） |
| `"permissions": []` | 明确什么都不要 | 同上，什么都不要 |
| `"permissions": ["log"]` | 只给 `log` | 只给 `log` |

写错的能力名（比如 `network`）不会生效，但会单独列出来：前端在插件条目上标红，
`plugin_run` 也会往 stderr 打一行提醒。大小写和首尾空格会被规整掉，重复项去重。

### 入参

宿主调用时把请求拆成 `action` / `path` / `content`：

| `action` | 调用 | 入参 |
| --- | --- | --- |
| `render`（默认） | `render(payload)` | 只有文件正文 |
| 其它 | `parse(request)` | `{path, content, action}` 整个请求 |

返回值统一是 `response{ok, value, error}`，宿主再包成 v1 那层 JSON 信封给前端：

```json
{ "ok": true, "value": "<table>…</table>", "error": null }
```

`value` 一律当字符串：HTML 由前端过一遍 DOMPurify 才进 DOM，插件没法靠返回值注入脚本。

### 插件侧（Rust）

```toml
[dependencies]
wit-bindgen = { version = "0.57", default-features = false, features = ["macros", "realloc", "std"] }
```

```rust
wit_bindgen::generate!({ path: "../../wit/plugin.wit", world: "plugin" });

use exports::xnote::plugin::api::Guest;
use xnote::plugin::types::{Request, Response};

struct MyPlugin;

impl Guest for MyPlugin {
    fn parse(req: Request) -> Response {
        Response { ok: true, value: render(&req.content), error: None }
    }
    fn render(payload: String) -> Response {
        Response { ok: true, value: render(&payload), error: None }
    }
}

export!(MyPlugin);
```

### 构建

```bash
cd plugins/csv-viewer
./build.sh          # Windows: build.bat
```

两条命令而已：

1. `cargo build --target wasm32-unknown-unknown` 得到核心模块（wit-bindgen 会在里面
   塞一段 `component-type` 自定义节，记录 WIT 类型信息）
2. `tools/wrap-component` 按这段信息把模块包成组件

第 2 步等价于 `wasm-tools component new core.wasm -o plugin.wasm`。之所以自带一个小工具，
是因为这样构建链只依赖 cargo：不用额外装 wasm-tools，也不用把 WASI 适配器接进来
（我们的插件没有 WASI 依赖）。

用别的语言也行，只要能产出组件：`cargo component`、`jco`、TinyGo 都有对应支持。

### 为什么值得换

| | v1 核心模块 | v2 组件 |
| --- | --- | --- |
| 传参 | 手写 `alloc` / `run` / `result_len` + 线性内存指针 | 规范 ABI 自动编解码 |
| 数据格式 | 插件自己解析 JSON（示例插件为此写了 60 行） | 直接拿 `string` / `record` |
| 接口 | 靠文档约定，错了运行时才炸 | WIT 定义，加载时就校验导入导出 |
| 能力 | 模块级 `import xnote.log` | 类型化接口 `import host`，权限面一眼可见 |

## v1：核心模块（兼容层）

> 新插件不要再用。这一节留着是为了看懂老插件、以及 `plugins.rs` 里那条兼容路径。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `memory` | linear memory | 宿主通过它读写数据 |
| `alloc` | `(len: i32) -> i32` | 申请的缓冲区首地址，宿主把输入 JSON 拷进去 |
| `run` | `(ptr: i32, len: i32) -> i32` | 处理输入，返回结果缓冲区首地址 |
| `result_len` | `() -> i32` | 上一次 `run` 产生的结果字节数 |

调用顺序固定：`alloc` → 拷入输入 → `run` → `result_len` → 从返回地址读结果。

宿主导入（模块名 `xnote`）：`log(level: i32, ptr: i32, len: i32)`、`now_ms() -> i64`。

## plugin.json

两代 ABI 用同一份清单：

```json
{
  "id": "csv-viewer",
  "name": "CSV 查看器",
  "version": "0.3.0",
  "author": "XFM",
  "description": "把 CSV / TSV 渲染成 HTML 表格（ABI v2 组件）",
  "abi": 2,
  "entry": "plugin.wasm",
  "extensions": [".csv", ".tsv"],
  "permissions": ["log", "read-setting"]
}
```

- `entry`：相对插件目录的 wasm 文件名
- `abi`：声明的版本，**只用于展示和市场筛选**，真正跑哪条路以文件头为准
- `permissions`：要用的宿主能力，不写就等于不要（v1 除外，见上文缺省规则）
- 只有两种情况会直接拒绝：声明了宿主不认识的版本（如 v3），或者声明 v2 却给了 v1 核心模块
  （报错会提示用 `wrap-component` 重新打包）

安装时会先读一遍包里的清单再问人：市场条目带 `permissions` 就直接显示；本地 zip 走
`plugin_peek_zip`，不落盘、只读清单与 wasm 文件头，确认框里列出这个插件将要拿到哪些能力。
索引里的 `permissions` 只是给人看的提示，装了之后以包里清单为准——两者不一致时前端会
明确提示「实际申请得更多」。

宿主扫描 `plugins/*/plugin.json`，同 id 以先扫到的目录为准（用户目录在安装包资源目录之前）。

## 用户设置

`read-setting(key)` 读的是应用数据目录下的 `plugin-settings.json`：

```json
{ "maxRows": "200" }
```

扁平对象，键值都是字符串；文件不存在时一律返回 `none`。插件拿不到别的任何宿主状态。
读它需要 `read-setting` 权限——示例插件用它调表格最多渲染多少行（默认 500，上限 5000）。

## 测试

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

- `plugin_abi`：文件头识别、版本协商、声明不符
- `plugin_perm`：缺省规则、大小写去重、未知键、报错文案
- `market::tests`：范围从 zip 里读清单——平铺 / 套一层目录、缺 wasm、声明与实际 ABI 不符
- `plugins::tests` 会真的跑插件：现场用 WAT 拼一个 v1 核心模块（验证兼容层）、
  一个不给权限的 v1/v2 插件（验证拒绝路径），以及 `plugins/csv-viewer/plugin.wasm`
  （验证组件路径）。示例没编译时依赖它的用例自动跳过
