#!/usr/bin/env bash
# 构建 CSV 查看器插件：产物直接落到本目录 plugin.wasm
set -euo pipefail
cd "$(dirname "$0")"

rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/csv_viewer.wasm ./plugin.wasm
echo "构建完成：$(pwd)/plugin.wasm"
