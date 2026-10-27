//! WASM 插件宿主（wasmtime）
//!
//! ## 0.1.0 的核心 ABI（见 `docs/plugin-abi.md`，目标形态见 `wit/plugin.wit`）
//!
//! 插件（guest）必须导出：
//! - `memory`                    线性内存
//! - `alloc(len: i32) -> i32`    由宿主调用，申请输入缓冲区
//! - `run(ptr: i32, len: i32) -> i32`  执行，返回结果缓冲区首地址
//! - `result_len() -> i32`       上一次 `run` 的结果字节数
//!
//! 宿主向插件导入（模块名 `xnote`）：
//! - `log(level: i32, ptr: i32, len: i32)`
//! - `now_ms() -> i64`
//!
//! 用核心 wasm ABI（而非 Component Model）是刻意的：不依赖 wit-bindgen 代码生成，
//! 任何能编译到 wasm32 的语言都能写插件；等 0.2.0 再把 ABI 升级成 WIT 组件。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 插件清单 plugin.json
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// ABI 版本，当前只支持 1
    #[serde(default = "default_abi")]
    pub abi: u32,
    /// wasm 文件名（相对插件目录）
    #[serde(default = "default_entry")]
    pub entry: String,
    /// 负责的扩展名，如 [".csv"]
    #[serde(default)]
    pub extensions: Vec<String>,
}

fn default_abi() -> u32 {
    1
}
fn default_entry() -> String {
    "plugin.wasm".to_string()
}

/// 暴露给前端的插件信息
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: Option<String>,
    pub description: Option<String>,
    pub abi: u32,
    pub extensions: Vec<String>,
    pub dir: String,
    /// wasm 文件是否就位（没编译过就是 false）
    pub available: bool,
}

pub struct PluginHost {
    dirs: Vec<PathBuf>,
    #[cfg(feature = "wasm-plugins")]
    engine: wasmtime::Engine,
    #[cfg(feature = "wasm-plugins")]
    cache: std::sync::Mutex<std::collections::HashMap<PathBuf, (u64, wasmtime::Module)>>,
}

impl PluginHost {
    pub fn new(dirs: Vec<PathBuf>) -> Self {
        Self {
            dirs,
            #[cfg(feature = "wasm-plugins")]
            engine: wasmtime::Engine::default(),
            #[cfg(feature = "wasm-plugins")]
            cache: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// 扫所有插件目录，读取 plugin.json（同 id 以靠前的目录为准，用户目录优先）
    fn scan(&self) -> Vec<(PluginManifest, PathBuf)> {
        let mut out: Vec<(PluginManifest, PathBuf)> = Vec::new();
        for dir in &self.dirs {
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let pdir = entry.path();
                if !pdir.is_dir() {
                    continue;
                }
                let manifest_path = pdir.join("plugin.json");
                let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
                    continue;
                };
                let Ok(manifest) = serde_json::from_str::<PluginManifest>(&raw) else {
                    continue;
                };
                if out.iter().any(|(m, _)| m.id == manifest.id) {
                    continue;
                }
                out.push((manifest, pdir));
            }
        }
        out
    }

    pub fn list(&self) -> Vec<PluginInfo> {
        self.scan()
            .into_iter()
            .map(|(m, dir)| {
                let wasm = dir.join(&m.entry);
                PluginInfo {
                    id: m.id,
                    name: m.name,
                    version: m.version,
                    author: m.author,
                    description: m.description,
                    abi: m.abi,
                    extensions: m.extensions,
                    dir: dir.to_string_lossy().to_string(),
                    available: wasm.is_file(),
                }
            })
            .collect()
    }

    #[cfg(feature = "wasm-plugins")]
    fn module_for(&self, path: &std::path::Path) -> Result<wasmtime::Module, String> {
        let mtime = std::fs::metadata(path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut cache = self.cache.lock().map_err(|e| e.to_string())?;
        if let Some((cached_at, module)) = cache.get(path) {
            if *cached_at == mtime {
                return Ok(module.clone());
            }
        }
        let module = wasmtime::Module::from_file(&self.engine, path)
            .map_err(|e| format!("加载 {} 失败：{e}", path.display()))?;
        cache.insert(path.to_path_buf(), (mtime, module.clone()));
        Ok(module)
    }

    pub fn run(&self, id: &str, input: &str) -> Result<String, String> {
        let Some((manifest, dir)) = self.scan().into_iter().find(|(m, _)| m.id == id) else {
            return Err(format!("找不到插件：{id}"));
        };
        if manifest.abi != 1 {
            return Err(format!(
                "插件 ABI v{} 不受支持（当前 v1）",
                manifest.abi
            ));
        }
        let wasm_path = dir.join(&manifest.entry);
        if !wasm_path.is_file() {
            return Err(format!(
                "插件未编译：{} 不存在，先按 README 构建",
                wasm_path.display()
            ));
        }

        self.exec_wasm(&wasm_path, input)
    }

    // 两个 cfg 版本的方法，而不是在 run() 里写两段 #[cfg] 的块表达式：
    // 块表达式在语句位置不会自动变成函数尾表达式，cfg 掉一段后另一段就成了 `()`。
    #[cfg(feature = "wasm-plugins")]
    fn exec_wasm(&self, wasm_path: &std::path::Path, input: &str) -> Result<String, String> {
        let module = self.module_for(wasm_path)?;
        exec(&self.engine, &module, input)
    }

    #[cfg(not(feature = "wasm-plugins"))]
    fn exec_wasm(&self, _wasm_path: &std::path::Path, _input: &str) -> Result<String, String> {
        Err("当前构建未启用 WASM 插件（Cargo feature wasm-plugins 关闭）".to_string())
    }
}
/// 宿主向插件暴露的上下文（目前只收集日志）
#[cfg(feature = "wasm-plugins")]
#[derive(Default)]
struct HostCtx {
    logs: Vec<String>,
}

#[cfg(feature = "wasm-plugins")]
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(feature = "wasm-plugins")]
fn slice_of(data: &[u8], ptr: i32, len: i32) -> Option<&[u8]> {
    if ptr < 0 || len < 0 {
        return None;
    }
    let start = ptr as usize;
    let end = start.checked_add(len as usize)?;
    if end > data.len() {
        return None;
    }
    Some(&data[start..end])
}

#[cfg(feature = "wasm-plugins")]
fn exec(
    engine: &wasmtime::Engine,
    module: &wasmtime::Module,
    input: &str,
) -> Result<String, String> {
    use wasmtime::{Caller, Extern, Linker, Store};

    let mut store: Store<HostCtx> = Store::new(engine, HostCtx::default());
    let mut linker: Linker<HostCtx> = Linker::new(engine);

    linker
        .func_wrap(
            "xnote",
            "log",
            |mut caller: Caller<'_, HostCtx>, level: i32, ptr: i32, len: i32| {
                let text = {
                    let Some(Extern::Memory(mem)) = caller.get_export("memory") else {
                        return;
                    };
                    let data = mem.data(&caller);
                    match slice_of(data, ptr, len) {
                        Some(slice) => format!("[L{level}] {}", String::from_utf8_lossy(slice)),
                        None => return,
                    }
                };
                caller.data_mut().logs.push(text);
            },
        )
        .map_err(|e| format!("注册 xnote.log 失败：{e}"))?;

    linker
        .func_wrap("xnote", "now_ms", || -> i64 { now_millis() })
        .map_err(|e| format!("注册 xnote.now_ms 失败：{e}"))?;

    let instance = linker
        .instantiate(&mut store, module)
        .map_err(|e| format!("插件实例化失败：{e}"))?;

    let memory = instance
        .get_memory(&mut store, "memory")
        .ok_or_else(|| "插件未导出 memory".to_string())?;
    let alloc = instance
        .get_typed_func::<i32, i32>(&mut store, "alloc")
        .map_err(|e| format!("插件缺少 alloc(len)->ptr：{e}"))?;
    let run = instance
        .get_typed_func::<(i32, i32), i32>(&mut store, "run")
        .map_err(|e| format!("插件缺少 run(ptr,len)->ptr：{e}"))?;
    let result_len = instance
        .get_typed_func::<(), i32>(&mut store, "result_len")
        .map_err(|e| format!("插件缺少 result_len()->i32：{e}"))?;

    let bytes = input.as_bytes();
    let ptr = alloc
        .call(&mut store, bytes.len() as i32)
        .map_err(|e| format!("alloc 调用失败：{e}"))?
        .max(0) as usize;
    {
        let mem = memory.data_mut(&mut store);
        let end = ptr
            .checked_add(bytes.len())
            .ok_or_else(|| "alloc 返回越界指针".to_string())?;
        if end > mem.len() {
            return Err("插件分配的内存不足".to_string());
        }
        mem[ptr..end].copy_from_slice(bytes);
    }

    let out_ptr = run
        .call(&mut store, (ptr as i32, bytes.len() as i32))
        .map_err(|e| format!("插件执行出错：{e}"))?;
    let len = result_len
        .call(&mut store, ())
        .map_err(|e| format!("读取结果长度失败：{e}"))?
        .max(0) as usize;

    let data = memory.data(&store);
    let start = out_ptr.max(0) as usize;
    let end = start
        .checked_add(len)
        .ok_or_else(|| "结果长度溢出".to_string())?;
    if end > data.len() {
        return Err("插件返回了越界指针".to_string());
    }
    String::from_utf8(data[start..end].to_vec())
        .map_err(|e| format!("插件返回的不是 UTF-8：{e}"))
}

// ---------------- Tauri 命令 ----------------

#[tauri::command]
pub fn plugin_list(state: tauri::State<'_, crate::AppState>) -> Vec<PluginInfo> {
    state.plugins.list()
}

/// 运行插件：input 与输出都是 JSON 字符串
#[tauri::command]
pub fn plugin_run(
    state: tauri::State<'_, crate::AppState>,
    id: String,
    input: String,
) -> Result<String, String> {
    state.plugins.run(&id, &input)
}
