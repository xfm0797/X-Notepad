//! 把 `wit-bindgen` 产出的核心 wasm 模块包成组件。
//!
//! 等价于 `wasm-tools component new core.wasm -o plugin.wasm`。之所以自己写一个
//! 小工具，是为了让插件的构建链只依赖 cargo：不用额外装 wasm-tools，也不用
//! 记得把绑定的 wasm 适配器接进来（我们的插件没有 WASI 依赖）。
//!
//! wit-bindgen 会在模块里塞一段 `component-type` 自定义节，记录 WIT 类型信息，
//! `ComponentEncoder` 就是照着它把核心模块“升格”成组件的。

use anyhow::{bail, Context, Result};
use std::process::ExitCode;

/// 组件二进制头：`\0asm` + 版本 0x000d + layer 0x0001
const COMPONENT_HEADER: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00];

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let (Some(input), Some(output)) = (args.next(), args.next()) else {
        eprintln!("用法：wrap-component <core.wasm> <component.wasm>");
        return ExitCode::from(2);
    };
    match run(&input, &output) {
        Ok(len) => {
            println!("包成组件：{output}（{len} 字节）");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("包装失败：{e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(input: &str, output: &str) -> Result<usize> {
    let module = std::fs::read(input).with_context(|| format!("读不到 {input}"))?;
    if is_component(&module) {
        bail!("{input} 已经是组件了，不需要再包一层");
    }
    let bytes = wit_component::ComponentEncoder::default()
        .module(&module)
        .context("这个核心模块不像 wit-bindgen 的产物（缺少 component-type 自定义节）")?
        .validate(true)
        .encode()
        .context("编码组件失败")?;
    std::fs::write(output, &bytes).with_context(|| format!("写不进 {output}"))?;
    Ok(bytes.len())
}

fn is_component(bytes: &[u8]) -> bool {
    bytes.len() >= COMPONENT_HEADER.len() && bytes[..COMPONENT_HEADER.len()] == COMPONENT_HEADER
}
