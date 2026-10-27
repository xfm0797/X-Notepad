//! X-Notepad 桌面端入口
// 发布构建时不弹控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    x_notepad_lib::run()
}
