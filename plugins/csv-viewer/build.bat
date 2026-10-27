@echo off
REM 构建 CSV 查看器插件：产物直接落到本目录 plugin.wasm
setlocal
cd /d "%~dp0"

rustup target add wasm32-unknown-unknown >nul 2>&1
cargo build --release --target wasm32-unknown-unknown || exit /b 1
copy /y "target\wasm32-unknown-unknown\release\csv_viewer.wasm" "plugin.wasm" >nul || exit /b 1

echo 构建完成：%~dp0plugin.wasm
