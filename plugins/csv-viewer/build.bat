@echo off
REM 构建 CSV 查看器插件（ABI v2 / Component Model）
REM   1. cargo build --target wasm32-unknown-unknown  -> 核心模块（内含 WIT 类型信息）
REM   2. tools/wrap-component 把它包成组件          -> 等价 wasm-tools component new
REM 产物：本目录 plugin.wasm（组件，文件头 0x000d）
setlocal
cd /d "%~dp0"

rustup target add wasm32-unknown-unknown >nul 2>&1
cargo build --release --target wasm32-unknown-unknown || exit /b 1
cargo run --release --manifest-path "..\..\tools\wrap-component\Cargo.toml" -- "target\wasm32-unknown-unknown\release\csv_viewer.wasm" "plugin.wasm" || exit /b 1

echo 构建完成：%~dp0plugin.wasm
