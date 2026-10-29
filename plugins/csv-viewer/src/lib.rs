//! CSV 查看器 —— X-Notepad 插件示例（ABI v2 / Component Model）
//!
//! 接口见仓库根目录 `wit/plugin.wit`。构建走 `./build.sh`：
//! `cargo build --target wasm32-unknown-unknown` 先产出核心模块，
//! 再由 `tools/wrap-component` 包成组件（等价 `wasm-tools component new`）。
//!
//! 相比 v1，这里少了两样东西：手写的 `alloc` / `run` / `result_len` 指针协议，
//! 和一个自己搓的 JSON 解析器——记录与字符串现在由组件模型搬运。

pub mod table;

/// 只有编到 wasm 时才需要 guest 胶水；本机 `cargo test` 只跑 table 里的纯逻辑。
#[cfg(target_arch = "wasm32")]
mod guest;
