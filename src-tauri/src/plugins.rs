//! WASM 插件宿主（wasmtime），同时支持两代 ABI。
//!
//! ## ABI v2（当前）：Component Model
//!
//! 接口由仓库根目录的 `wit/plugin.wit` 描述，插件的 wasm 是一个**组件**：
//! 导出 `xnote:plugin/api`（`parse` / `render`），导入 `xnote:plugin/host`
//! （`log` / `now-ms` / `read-setting`）。字符串和记录由组件模型的规范 ABI
//! 负责编解码，插件侧不再需要 `alloc` / `run` / `result_len`，也不用自己解析 JSON。
//!
//! ## ABI v1（兼容）：核心 wasm + 手写指针协议
//!
//! 老插件仍然能跑：导出 `memory` / `alloc(len)->ptr` / `run(ptr,len)->ptr` /
//! `result_len()->i32`，导入模块 `xnote` 下的 `log` / `now_ms`，全部数据都是一段
//! JSON。历史细节见 `docs/plugin-abi.md`。
//!
//! 两条路靠文件头自动分流，见 [`crate::plugin_abi`]。

// 关掉 wasm-plugins 时，v2 的入参 / JSON 信封这些类型天然没人用，别拿它们刷警告
#![cfg_attr(not(feature = "wasm-plugins"), allow(dead_code))]

use crate::plugin_abi::{self, Binary};
use crate::plugin_perm;
use crate::plugin_sig;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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
    /// 声明的 ABI 版本（实际执行形态以 wasm 文件头为准）
    #[serde(default = "default_abi")]
    pub abi: u32,
    /// wasm 文件名（相对插件目录）
    #[serde(default = "default_entry")]
    pub entry: String,
    /// 负责的扩展名，如 [".csv"]
    #[serde(default)]
    pub extensions: Vec<String>,
    /// 要用到的宿主能力（`log` / `now-ms` / `read-setting`）。
    /// 不写这个字段：v1 给 log + now-ms（历史行为），v2 什么都不给；
    /// 写成 `[]` 就是明确不要任何能力。
    #[serde(default)]
    pub permissions: Option<Vec<String>>,
}

fn default_abi() -> u32 {
    plugin_abi::ABI_LEGACY
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
    /// 实际 ABI：插件文件就位时按文件头算，否则用 plugin.json 的声明
    pub abi: u32,
    pub extensions: Vec<String>,
    /// 这次运行实际被授予的能力
    pub permissions: Vec<String>,
    /// 清单里写了但宿主不认识的能力名（多半是拼错了）
    pub unknown_permissions: Vec<String>,
    /// 包签名状态：验签在新装时做过，这里对目录再算一遍摘要，防止装完之后被人改文件
    pub signature: plugin_sig::SignatureInfo,
    pub dir: String,
    /// wasm 文件是否就位（没编译过就是 false）
    pub available: bool,
}

/// 宿主向插件发来的请求（v2 的结构化入参；v1 把原始 JSON 直接丢给插件）
#[derive(Debug, Default, Deserialize)]
struct RunInput {
    #[serde(default)]
    action: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    content: String,
}

pub struct PluginHost {
    dirs: Vec<PathBuf>,
    /// `plugin-settings.json`：v2 插件 `read-setting` 的来源
    settings: PathBuf,
    /// 信任的签名公钥：`plugin-keys.json`（内置官方密钥在 `plugin_sig` 里）
    keys: PathBuf,
    #[cfg(feature = "wasm-plugins")]
    engine: wasmtime::Engine,
    #[cfg(feature = "wasm-plugins")]
    cache: std::sync::Mutex<std::collections::HashMap<PathBuf, (u64, Loaded)>>,
}

/// 已经编译好的插件产物，按文件 mtime 缓存
#[cfg(feature = "wasm-plugins")]
#[derive(Clone)]
enum Loaded {
    Component(wasmtime::component::Component),
    Core(wasmtime::Module),
}

impl PluginHost {
    pub fn new(dirs: Vec<PathBuf>, settings: PathBuf, keys: PathBuf) -> Self {
        Self {
            dirs,
            settings,
            keys,
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
        let keys = plugin_sig::trusted_keys(plugin_sig::load_keys(&self.keys));
        self.scan()
            .into_iter()
            .map(|(m, dir)| {
                let wasm = dir.join(&m.entry);
                let binary = read_header(&wasm).map(|h| plugin_abi::detect(&h)).ok();
                let abi = match binary {
                    Some(b) => plugin_abi::effective_abi(m.abi, b),
                    None => m.abi,
                };
                let grant = plugin_perm::Grant::resolve(m.permissions.as_deref(), abi);
                PluginInfo {
                    abi,
                    permissions: grant.keys().to_vec(),
                    unknown_permissions: grant.unknown().to_vec(),
                    signature: plugin_sig::verify_dir(&dir, &keys),
                    id: m.id,
                    name: m.name,
                    version: m.version,
                    author: m.author,
                    description: m.description,
                    extensions: m.extensions,
                    dir: dir.to_string_lossy().to_string(),
                    available: wasm.is_file(),
                }
            })
            .collect()
    }

    pub fn run(&self, id: &str, input: &str) -> Result<String, String> {
        let Some((manifest, dir)) = self.scan().into_iter().find(|(m, _)| m.id == id) else {
            return Err(format!("找不到插件：{id}"));
        };
        let wasm_path = dir.join(&manifest.entry);
        if !wasm_path.is_file() {
            return Err(format!(
                "插件未编译：{} 不存在，先按 README 构建",
                wasm_path.display()
            ));
        }
        let header = read_header(&wasm_path)?;
        let mode = plugin_abi::negotiate(manifest.abi, plugin_abi::detect(&header))?;

        // 能力按**实际形态**算默认值：清单声明得再漂亮，跑的是组件就按 v2 的规矩来
        let abi = match mode {
            Binary::Component => 2,
            _ => 1,
        };
        let grant = plugin_perm::Grant::resolve(manifest.permissions.as_deref(), abi);
        if !grant.unknown().is_empty() {
            eprintln!("[plugin:{id}] {}", plugin_perm::unknown_message(grant.unknown()));
        }

        let (result, logs, denied) = match mode {
            Binary::Component => self.exec_component_path(&wasm_path, input, grant),
            _ => self.exec_core_path(&wasm_path, input, grant),
        };
        for line in logs {
            eprintln!("[plugin:{id}] {line}");
        }
        if !denied.is_empty() {
            return Err(plugin_perm::denial_message(&denied));
        }
        result
    }

    #[cfg(feature = "wasm-plugins")]
    fn load_binary(&self, path: &Path, mode: Binary) -> Result<Loaded, String> {
        let mtime = std::fs::metadata(path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut cache = self.cache.lock().map_err(|e| e.to_string())?;
        if let Some((cached_at, loaded)) = cache.get(path) {
            let fresh = *cached_at == mtime
                && matches!(
                    (mode, loaded),
                    (Binary::Component, Loaded::Component(_)) | (Binary::Core, Loaded::Core(_))
                );
            if fresh {
                return Ok(loaded.clone());
            }
        }
        let loaded = match mode {
            Binary::Component => Loaded::Component(
                wasmtime::component::Component::from_file(&self.engine, path)
                    .map_err(|e| format!("加载组件 {} 失败：{e}", path.display()))?,
            ),
            _ => Loaded::Core(
                wasmtime::Module::from_file(&self.engine, path)
                    .map_err(|e| format!("加载 {} 失败：{e}", path.display()))?,
            ),
        };
        cache.insert(path.to_path_buf(), (mtime, loaded.clone()));
        Ok(loaded)
    }

    #[cfg(feature = "wasm-plugins")]
    fn exec_component_path(
        &self,
        path: &Path,
        input: &str,
        grant: plugin_perm::Grant,
    ) -> (Result<String, String>, Vec<String>, Vec<String>) {
        let component = match self.load_binary(path, Binary::Component) {
            Ok(Loaded::Component(c)) => c,
            Ok(_) => return (Err("插件产物类型和声明的 ABI 对不上".to_string()), Vec::new(), Vec::new()),
            Err(e) => return (Err(e), Vec::new(), Vec::new()),
        };
        exec_component(&self.engine, &component, input, grant, self.load_settings())
    }

    #[cfg(feature = "wasm-plugins")]
    fn exec_core_path(
        &self,
        path: &Path,
        input: &str,
        grant: plugin_perm::Grant,
    ) -> (Result<String, String>, Vec<String>, Vec<String>) {
        let module = match self.load_binary(path, Binary::Core) {
            Ok(Loaded::Core(m)) => m,
            Ok(_) => return (Err("插件产物类型和声明的 ABI 对不上".to_string()), Vec::new(), Vec::new()),
            Err(e) => return (Err(e), Vec::new(), Vec::new()),
        };
        exec_core(&self.engine, &module, input, grant)
    }

    // 关掉 wasm-plugins feature 时的两个替身，签名与上面保持一致
    #[cfg(not(feature = "wasm-plugins"))]
    fn exec_component_path(
        &self,
        _path: &Path,
        _input: &str,
        _grant: plugin_perm::Grant,
    ) -> (Result<String, String>, Vec<String>, Vec<String>) {
        (Err(disabled_msg()), Vec::new(), Vec::new())
    }

    #[cfg(not(feature = "wasm-plugins"))]
    fn exec_core_path(
        &self,
        _path: &Path,
        _input: &str,
        _grant: plugin_perm::Grant,
    ) -> (Result<String, String>, Vec<String>, Vec<String>) {
        (Err(disabled_msg()), Vec::new(), Vec::new())
    }

    /// `plugin-settings.json`：一个扁平的对象，插件通过 `read-setting` 按 key 取
    fn load_settings(&self) -> Vec<(String, String)> {
        let Ok(raw) = std::fs::read_to_string(&self.settings) else {
            return Vec::new();
        };
        serde_json::from_str::<std::collections::BTreeMap<String, String>>(&raw)
            .map(|m| m.into_iter().collect())
            .unwrap_or_default()
    }
}

#[cfg(not(feature = "wasm-plugins"))]
fn disabled_msg() -> String {
    "当前构建未启用 WASM 插件（Cargo feature wasm-plugins 关闭）".to_string()
}

/// 读文件头 8 字节
fn read_header(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("读不了 {}：{e}", path.display()))?;
    let mut buf = [0u8; 8];
    let n = file
        .read(&mut buf)
        .map_err(|e| format!("读不了 {}：{e}", path.display()))?;
    Ok(buf[..n].to_vec())
}

// ---------------- v2：组件 ----------------

/// 宿主向插件暴露的上下文
#[cfg(feature = "wasm-plugins")]
struct HostCtx {
    logs: Vec<String>,
    settings: Vec<(String, String)>,
    /// 这次运行允许用哪些能力
    grant: plugin_perm::Grant,
    /// 插件伸手要了但没被授予的能力（去重，按第一次出现的顺序）
    denied: Vec<String>,
}

#[cfg(feature = "wasm-plugins")]
impl HostCtx {
    fn new(grant: plugin_perm::Grant, settings: Vec<(String, String)>) -> Self {
        Self {
            logs: Vec::new(),
            settings,
            grant,
            denied: Vec::new(),
        }
    }

    /// 记一次越权尝试；返回 false 表示这个能力没给
    fn allow(&mut self, key: &str) -> bool {
        if self.grant.allows(key) {
            return true;
        }
        if !self.denied.iter().any(|k| k == key) {
            self.denied.push(key.to_string());
        }
        false
    }
}

#[cfg(feature = "wasm-plugins")]
mod abi2 {
    //! `wit/plugin.wit` 的宿主侧绑定。生成的类型在 `xnote::plugin::*` 下。
    wasmtime::component::bindgen!({
        path: "../wit/plugin.wit",
        world: "plugin",
    });
}

/// `types` 接口只有记录、没有函数，空实现即可（bindgen 要求它存在）
#[cfg(feature = "wasm-plugins")]
impl abi2::xnote::plugin::types::Host for HostCtx {}

#[cfg(feature = "wasm-plugins")]
impl abi2::xnote::plugin::host::Host for HostCtx {
    fn log(&mut self, level: u32, message: String) {
        if !self.allow(plugin_perm::LOG) {
            return;
        }
        let tag = match level {
            0 => "info",
            1 => "warn",
            _ => "error",
        };
        self.logs.push(format!("[{tag}] {message}"));
    }

    fn now_ms(&mut self) -> u64 {
        if !self.allow(plugin_perm::NOW_MS) {
            return 0;
        }
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// 没给权限就当这个键不存在（插件拿到 None，不会拿到别的键的值）
    fn read_setting(&mut self, key: String) -> Option<String> {
        if !self.allow(plugin_perm::READ_SETTING) {
            return None;
        }
        self.settings
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.clone())
    }
}

#[cfg(feature = "wasm-plugins")]
fn exec_component(
    engine: &wasmtime::Engine,
    component: &wasmtime::component::Component,
    input: &str,
    grant: plugin_perm::Grant,
    settings: Vec<(String, String)>,
) -> (Result<String, String>, Vec<String>, Vec<String>) {
    use abi2::xnote::plugin::types::{Request, Response};
    use wasmtime::component::Linker;
    use wasmtime::Store;

    let req: RunInput = match serde_json::from_str(input) {
        Ok(req) => req,
        Err(e) => {
            return (
                Err(format!("插件入参不是合法 JSON：{e}")),
                Vec::new(),
                Vec::new(),
            )
        }
    };

    let mut store = Store::new(engine, HostCtx::new(grant, settings));
    let mut linker: Linker<HostCtx> = Linker::new(engine);
    // wasmtime 50 的 `add_to_linker<T, D>`：D 是“数据怎么从 store 里取出来”，
    // HasSelf<HostCtx> 就是最常见的「store 里直接放着 HostCtx」
    let out = (|| -> Result<String, String> {
        abi2::Plugin::add_to_linker::<HostCtx, wasmtime::component::HasSelf<HostCtx>>(
            &mut linker,
            |ctx| ctx,
        )
        .map_err(|e| format!("注册 host 接口失败：{e}"))?;

        let instance = abi2::Plugin::instantiate(&mut store, component, &linker)
            .map_err(|e| format!("组件实例化失败：{e}"))?;
        let api = instance.xnote_plugin_api();

        let resp: Response = if req.action == "render" {
            api.call_render(&mut store, &req.content)
                .map_err(|e| format!("插件执行出错：{e}"))?
        } else {
            api.call_parse(
                &mut store,
                &Request {
                    path: req.path,
                    content: req.content,
                    action: req.action,
                },
            )
            .map_err(|e| format!("插件执行出错：{e}"))?
        };
        Ok(envelope(resp.ok, resp.value, resp.error))
    })();

    // 插件在沙箱里攒的日志要带回去（打印在 run 里，调用方不用管）；
    // denied 也要带回去——有越权就让整次调用失败，别让插件把半成品当结果
    let logs = std::mem::take(&mut store.data_mut().logs);
    let denied = std::mem::take(&mut store.data_mut().denied);
    (out, logs, denied)
}

/// 统一成 v1 的 JSON 信封，前端不用分两代
fn envelope(ok: bool, value: String, error: Option<String>) -> String {
    serde_json::json!({ "ok": ok, "value": value, "error": error }).to_string()
}

// ---------------- v1：核心模块 ----------------

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
fn exec_core(
    engine: &wasmtime::Engine,
    module: &wasmtime::Module,
    input: &str,
    grant: plugin_perm::Grant,
) -> (Result<String, String>, Vec<String>, Vec<String>) {
    use wasmtime::{Caller, Extern, Linker, Store};

    // v1 只有 log / now_ms 两个导入，用不上 settings
    let mut store: Store<HostCtx> = Store::new(engine, HostCtx::new(grant, Vec::new()));
    let mut linker: Linker<HostCtx> = Linker::new(engine);

    let out = (|| -> Result<String, String> {
        linker
            .func_wrap(
                "xnote",
                "log",
                |mut caller: Caller<'_, HostCtx>, level: i32, ptr: i32, len: i32| {
                    if !caller.data_mut().allow(plugin_perm::LOG) {
                        return;
                    }
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
            .func_wrap("xnote", "now_ms", |mut caller: Caller<'_, HostCtx>| -> i64 {
                if !caller.data_mut().allow(plugin_perm::NOW_MS) {
                    return 0;
                }
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0)
            })
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
    })();

    let logs = std::mem::take(&mut store.data_mut().logs);
    let denied = std::mem::take(&mut store.data_mut().denied);
    (out, logs, denied)
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

// ---------------- 端到端：真的把两代插件跑一遍 ----------------

#[cfg(all(test, feature = "wasm-plugins"))]
mod tests {
    use super::*;

    /// 造一个临时插件根目录：root/<id>/plugin.{json,wasm}
    fn temp_plugin_root(tag: &str, id: &str, manifest: &str, wasm: &[u8]) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("xnote-plugin-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let pdir = root.join(id);
        std::fs::create_dir_all(&pdir).unwrap();
        std::fs::write(pdir.join("plugin.json"), manifest).unwrap();
        std::fs::write(pdir.join("plugin.wasm"), wasm).unwrap();
        (root, pdir)
    }

    /// v1 兼容层：手写一个最小核心模块，确认老插件不用重写也能跑
    #[test]
    fn runs_legacy_core_module() {
        let json = r#"{"ok":true,"value":"<p>v1</p>","error":null}"#;
        let data = json.replace('\\', "\\\\").replace('"', "\\\"");
        let wat = format!(
            r#"(module
                 (memory (export "memory") 1)
                 (data (i32.const 1024) "{data}")
                 (func (export "alloc") (param i32) (result i32) i32.const 2048)
                 (func (export "run") (param i32 i32) (result i32) i32.const 1024)
                 (func (export "result_len") (result i32) i32.const {len}))"#,
            len = json.len()
        );
        let wasm = wat::parse_str(&wat).unwrap();
        let manifest = r#"{"id":"legacy-demo","name":"老插件","version":"0.1.0","abi":1}"#;
        let (root, pdir) = temp_plugin_root("v1", "legacy-demo", manifest, &wasm);

        let host = PluginHost::new(vec![root.clone()], pdir.join("no-settings.json"), pdir.join("no-keys.json"));
        assert_eq!(host.list()[0].abi, plugin_abi::ABI_LEGACY);
        let out = host.run("legacy-demo", r#"{"action":"render"}"#).unwrap();
        assert_eq!(out, json);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 声明 v2 却给了核心模块：报错要指向 wrap-component
    #[test]
    fn declared_v2_with_core_binary_is_rejected() {
        let wasm = wat::parse_str("(module)").unwrap();
        let manifest = r#"{"id":"confused","name":"搞错了","version":"0.1.0","abi":2}"#;
        let (root, pdir) = temp_plugin_root("mismatch", "confused", manifest, &wasm);

        let host = PluginHost::new(vec![root.clone()], pdir.join("no-settings.json"), pdir.join("no-keys.json"));
        let err = host.run("confused", "{}").unwrap_err();
        assert!(err.contains("wrap-component"), "{err}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// v1 插件没声明 log 却调用了：整次运行报错，并指出缺哪个能力
    #[test]
    fn v1_module_needs_declared_permission() {
        let wat = r#"(module
             (import "xnote" "log" (func $log (param i32 i32 i32)))
             (memory (export "memory") 1)
             (data (i32.const 1024) "{}")
             (func (export "alloc") (param i32) (result i32) i32.const 2048)
             (func (export "run") (param i32 i32) (result i32)
               (call $log (i32.const 0) (i32.const 1024) (i32.const 2))
               (i32.const 1024))
             (func (export "result_len") (result i32) i32.const 2))"#;
        let wasm = wat::parse_str(wat).unwrap();

        let stingy = r#"{"id":"mute","name":"不给日志","version":"0.1.0","abi":1,"permissions":[]}"#;
        let (root, pdir) = temp_plugin_root("v1-deny", "mute", stingy, &wasm);
        let host = PluginHost::new(vec![root.clone()], pdir.join("no-settings.json"), pdir.join("no-keys.json"));
        let err = host.run("mute", "{}").unwrap_err();
        assert!(err.contains("log"), "{err}");
        assert!(err.contains("permissions"), "{err}");
        let _ = std::fs::remove_dir_all(&root);

        let allowed = r#"{"id":"mute","name":"给日志","version":"0.1.0","abi":1,"permissions":["log"]}"#;
        let (root, pdir) = temp_plugin_root("v1-allow", "mute", allowed, &wasm);
        let host = PluginHost::new(vec![root.clone()], pdir.join("no-settings.json"), pdir.join("no-keys.json"));
        assert_eq!(host.run("mute", "{}").unwrap(), "{}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// v2：同一个组件，清单里不写 permissions 就调不动 host
    #[test]
    fn component_runs_only_with_declared_permissions() {
        let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/csv-viewer/plugin.wasm");
        if !src.is_file() {
            eprintln!("跳过：先跑 plugins/csv-viewer/build.sh");
            return;
        }
        let wasm = std::fs::read(&src).unwrap();
        let manifest = r#"{"id":"stingy","name":"什么都不给","version":"0.1.0","abi":2,"permissions":[]}"#;
        let (root, pdir) = temp_plugin_root("v2-deny", "stingy", manifest, &wasm);

        let host = PluginHost::new(vec![root.clone()], pdir.join("no-settings.json"), pdir.join("no-keys.json"));
        let info = &host.list()[0];
        assert!(info.permissions.is_empty());
        let err = host
            .run("stingy", r#"{"action":"render","content":"a,b\n1,2\n"}"#)
            .unwrap_err();
        assert!(err.contains("log"), "{err}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// v2：跑仓库里的示例插件（组件）。样例没编译时不算失败，只是跳过
    #[test]
    fn runs_component_example() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins");
        if !root.join("csv-viewer/plugin.wasm").is_file() {
            eprintln!("跳过：先跑 plugins/csv-viewer/build.sh");
            return;
        }
        let host = PluginHost::new(vec![root.clone()], root.join("no-settings.json"), root.join("no-keys.json"));
        let info = &host.list()[0];
        assert_eq!(info.abi, plugin_abi::ABI_COMPONENT);
        assert_eq!(info.permissions, ["log", "read-setting"]);

        let input = r#"{"action":"render","path":"/tmp/a.csv","content":"a,b\n1,2\n"}"#;
        let out = host.run("csv-viewer", input).unwrap();
        assert!(out.contains("<th>a</th>"), "{out}");
        assert!(out.contains("<td>2</td>"), "{out}");
        assert!(out.contains("\"ok\":true"), "{out}");

        // parse 分支走的是同一套渲染
        let parsed = host
            .run("csv-viewer", r#"{"action":"parse","path":"/tmp/a.tsv","content":"x\ty\n"}"#)
            .unwrap();
        assert!(parsed.contains("<th>y</th>"), "{parsed}");
    }
}
