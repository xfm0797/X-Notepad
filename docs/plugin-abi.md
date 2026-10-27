# 插件 ABI v1（核心 wasm）

0.1.0 刻意不依赖 `wit-bindgen`：插件就是一个普通的 `wasm32` 模块，任何能编译到
wasm 的语言都能写。语义等价于 `wit/plugin.wit` 里描述的那种组件接口，只是二进制层面
用手写的线性内存约定。

## 插件必须导出

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `memory` | linear memory | 宿主通过它读写数据 |
| `alloc` | `(len: i32) -> i32` | 申请的缓冲区首地址，宿主把输入 JSON 拷进去 |
| `run` | `(ptr: i32, len: i32) -> i32` | 处理输入，返回结果缓冲区首地址 |
| `result_len` | `() -> i32` | 上一次 `run` 产生的结果字节数 |

调用顺序固定：`alloc` → 拷入输入 → `run` → `result_len` → 从返回地址读结果。
所有字符串都是 UTF-8 的 JSON。

## 宿主导入（模块名 `xnote`）

| 导入 | 签名 | 说明 |
| --- | --- | --- |
| `log` | `(level: i32, ptr: i32, len: i32)` | 写日志，level 0=info 1=warn 2=error |
| `now_ms` | `() -> i64` | 当前毫秒时间戳 |

插件拿不到文件系统、网络、环境变量 —— 除了上面两个函数，沙箱里什么都没有。
需要什么能力，必须先在这里加一条显式导入，宿主再决定给不给。

## plugin.json

```json
{
  "id": "csv-viewer",
  "name": "CSV 查看器",
  "version": "0.1.0",
  "author": "XFM",
  "description": "把 CSV 渲染成表格",
  "abi": 1,
  "entry": "plugin.wasm",
  "extensions": [".csv", ".tsv"]
}
```

`entry` 是相对插件目录的 wasm 文件名。宿主扫描 `plugins/*/plugin.json`，
同 id 以先扫描到的目录为准（用户目录在安装包资源目录之前）。

## 输入 / 输出约定

输入：

```json
{ "action": "render", "path": "/abs/a.csv", "content": "a,b\n1,2\n" }
```

输出：

```json
{ "ok": true, "value": "<table>…</table>", "error": null }
```

`value` 一律当字符串处理：HTML 由前端过一遍 DOMPurify 再插入 DOM，
所以插件无法借返回值注入脚本。

## 迁移到 Component Model（0.2.0）

届时：`wasmtime::component::bindgen!` + `wit/plugin.wit`，插件侧用
`cargo component build`。核心 wasm ABI 会保留一个兼容层，已有插件不用重写。
