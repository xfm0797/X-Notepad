# X-Notepad

笔记与代码，一个窗口。Tauri 2 + CodeMirror 6 + WebAssembly 插件。

> 0.1.0 打底：编辑器、文件树、标签页、Markdown 分屏预览、编码安全读写跑通，
> 插件系统走 wasmtime 沙箱（ABI v1），示例插件是 CSV 查看器。
> 0.2.0 补齐文件树增删改、外部修改检测与崩溃恢复、WASM 插件市场。

## 为什么是这套栈

大纲原始方案是「Tauri + Scintilla（Rust 绑定）+ wasmtime」，落地时改了三处：

| 原方案 | 实际采用 | 原因 |
| --- | --- | --- |
| Scintilla（原生控件） | **CodeMirror 6** | Scintilla 只有 FFI 裸绑定（`scintilla-sys`，1.4 万下载、2025 年后停更），塞进 Tauri 窗口要给 Win32/Cocoa/GTK 各写一套挂载代码，React 那层 UI 还得给它让位。CM6 是视口渲染，语言包按需 `import()` |
| 启动 <0.3s、内存 <50MB | **<1s / <120MB（目标）** | WebView2 初始化本身就 300ms 起，50MB 只有自绘原生 UI 才做得到；这两个指标和 WebView 路线物理冲突 |
| 插件写成 TS 接口 + 同时支持 `.js` | **纯 WASM，ABI v1** | WebView 里跑的 `.js` 插件能拿到 `invoke`，沙箱形同虚设；统一成 wasm 后插件真的碰不到文件系统 |

Markdown 用 comrak（GFM：表格/任务列表/删除线/脚注/自动链接）在 Rust 侧解析，
前端只负责把 HTML 塞进 DOM，并且每次都过一遍 DOMPurify。

## 技术栈

- 外壳：Tauri 2（Rust）
- 前端：React 19 + TypeScript + Vite 8
- 编辑器：CodeMirror 6 + `@codemirror/language-data`（100+ 语言懒加载）
- Markdown：comrak 0.59（Rust）
- 编码：chardetng + encoding_rs（UTF-8 / GBK / Shift-JIS … 读进来什么样、存回去还什么样）
- 元数据：rusqlite（标签 / 收藏 / 最近打开）
- 插件：wasmtime 50，核心 wasm ABI
- 状态：zustand

## 目录

```
src-tauri/            Rust 后端
  src/lib.rs          启动、状态、命令注册
  src/fsx.rs          目录树 / 编码检测 / 原子写入
  src/markdown.rs     comrak GFM 渲染
  src/meta.rs         SQLite 元数据
  src/plugins.rs      wasmtime 宿主（feature = "wasm-plugins"）
  src/watch.rs        notify 文件监听 → 前端事件
  src/market.rs       插件市场：拉索引 / 下 zip / 解包安装
src/                  React 前端
  lib/api.ts          invoke 封装 + 浏览器演示工作区
  lib/lang.ts         扩展名 → CodeMirror 语言
  lib/path.ts         跨平台路径拼接 / 文件名校验
  lib/drafts.ts       未保存草稿兜底（localStorage）
  lib/watch.ts        文件监听事件订阅
  lib/market.ts       插件市场索引（多源 + 破缓存）
  store/workspace.ts  标签页 / 文档 / 自动保存 / 外部修改 / 草稿恢复
  store/dialogs.ts    输入框 / 确认 / 多选一
  components/         Toolbar · FileTree · TabBar · EditorPane · PreviewPane · StatusBar
                      PluginsPanel（已安装 + 市场）· ExternalBanner · Dialogs
plugins/csv-viewer/   示例插件（Rust cdylib → wasm32）
wit/plugin.wit        ABI 的组件化目标形态（0.2.0）
docs/plugin-abi.md    ABI v1 的具体约定
market/index.json     插件市场索引（客户端按 jsDelivr → GitHub → Gitee 顺序找）
scripts/gen-icon.py   图标生成（无第三方依赖）
scripts/pack-plugin.ps1  把插件目录打成市场用 zip
```

## 开发

```bash
npm install
npm run dev          # 只跑前端：浏览器里是内存示例工作区，不需要 Rust
npm run tauri:dev    # 完整应用（需要 Rust 工具链 + Windows 上装 MSVC Build Tools）
npm run build        # 前端产物
npm run tauri:build  # 出安装包
```

> 本机当前没有 `cargo` / `rustc`，所以 **Rust 侧只做了静态审查，未经编译验证**；
> 第一次 `npm run tauri:dev` 或 CI 才是真正的编译校验。前端 `tsc --noEmit` 与 `vite build` 均通过。

## 写一个插件

插件就是一个 `wasm32` 模块，导出 `alloc` / `run` / `result_len`，可以从宿主 import
`xnote.log` 和 `xnote.now_ms`。完整约定见 [`docs/plugin-abi.md`](docs/plugin-abi.md)。

```bash
cd plugins/csv-viewer
./build.sh          # Windows: build.bat
```

产物 `plugin.wasm` 与 `plugin.json` 放在同一个目录，把这个目录整体放进：

```
%APPDATA%\pw.lovou.xnotepad\plugins\<插件名>\
```

重启应用，工具栏「插件」里就能看到并直接对当前文件运行。

## 日常操作

| 想做的事 | 怎么做 |
| --- | --- |
| 新建文件 / 文件夹 | 文件树右键，或 `Ctrl+N` / `Ctrl+Shift+N`，或侧栏顶部 `＋` `▤` |
| 重命名 / 删除 | 文件树右键（删除有二次确认） |
| 保存 | `Ctrl+S` 立即保存，停手 1.2 秒也会自动保存 |
| 关掉有改动的标签 | 会问「保存并关闭 / 不保存」 |
| 找插件 | 工具栏「插件 → 插件市场」，也可以「本地安装」选一个 zip |

### 外部修改与崩溃恢复

- **外部修改**：工作区开着 `notify` 监听。别的程序（或同步盘）改了当前打开的文件时，
  编辑器上方会出现提示条，让你选择「重新载入」还是「保留我的修改」——绝不悄悄覆盖。
  自己保存触发的写入会被 1.5 秒的自写窗口过滤掉。
- **崩溃恢复**：编辑时每 0.6 秒把缓冲区写一份到 localStorage（最多 3MB，超过丢最旧的）。
  如果进程被强杀，下次启动会问要不要把这几篇未保存的内容捡回来。

## 路线图

**0.1.0（已完成）**
- [x] 目录树、标签页、多语言语法高亮、查找替换、代码折叠
- [x] Markdown 分屏预览（comrak + DOMPurify）
- [x] 编码检测 / 换行符保持 / 原子写入 / 自动保存（1.2s 防抖）
- [x] 亮暗主题、状态栏、最近打开（SQLite）
- [x] WASM 插件宿主 + CSV 查看器示例
- [x] 新建 / 重命名 / 删除（右键菜单 + 对话框，标签页同步改名）
- [x] 外部修改检测（notify）、崩溃恢复

**0.2.0（当前）**
- [x] 插件市场：`market/index.json` + 三源回退 + 时间戳破 CDN 缓存
- [x] 安装 / 更新 / 卸载 / 本地 zip 安装（解包带 zip-slip 防护）
- [ ] 插件 ABI 升级到 Component Model（`wit/plugin.wit`），保留 v1 兼容层
- [ ] 多窗口、会话恢复

**之后**
- [ ] 命令面板、大纲、全文搜索（SQLite FTS5）
- [ ] 标签编辑、双链

## 许可

[MIT](LICENSE) © 2026 XFM
