#!/usr/bin/env bash
# 构建 CSV 查看器插件（ABI v2 / Component Model）
#
#   1. cargo build --target wasm32-unknown-unknown  → 核心模块（内含 WIT 类型信息）
#   2. tools/wrap-component 把它包成组件            → 等价 wasm-tools component new
#
# 产物：本目录 plugin.wasm（组件，文件头 0x000d）
set -euo pipefail
cd "$(dirname "$0")"

rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo build --release --target wasm32-unknown-unknown
cargo run --release --manifest-path ../../tools/wrap-component/Cargo.toml -- \
  target/wasm32-unknown-unknown/release/csv_viewer.wasm plugin.wasm

echo "构建完成：$(pwd)/plugin.wasm"
