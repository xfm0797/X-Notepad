/**
 * Tauri invoke 的统一封装。
 *
 * 浏览器里（`npm run dev` 直接开 5173）没有 Rust 后端，
 * 这里退回一份内存里的示例工作区，让 UI 可以独立调试。
 */
import { invoke } from '@tauri-apps/api/core'
import { baseName, joinPath, parentOf } from './path'

export interface TreeNode {
  name: string
  path: string
  isDir: boolean
  size: number
  ext: string
  children?: TreeNode[] | null
}

export interface FilePayload {
  path: string
  content: string
  encoding: string
  eol: 'LF' | 'CRLF'
  size: number
  binary: boolean
  mtime: number
}

export interface SaveResult {
  size: number
  mtime: number
}

export interface FileStat {
  exists: boolean
  size: number
  mtime: number
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  author?: string | null
  description?: string | null
  abi: number
  extensions: string[]
  dir: string
  available: boolean
}

export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as unknown as Record<string, unknown>)

/* ------------------------------------------------------------------ */
/* 浏览器演示工作区                                                      */
/* ------------------------------------------------------------------ */

const DEMO_ROOT = '/demo'

const demoFiles: Record<string, string> = {
  [`${DEMO_ROOT}/README.md`]: `---
tags: [入门, 产品]
---

# X-Notepad

笔记 + 代码编辑器，一个窗口解决。相关笔记：[[想法]]、[[索引]]

## 为什么是这套技术栈

| 关注点 | 选择 | 原因 |
| --- | --- | --- |
| 外壳 | Tauri 2 | 用系统 WebView，包体个位数 MB |
| 编辑器 | CodeMirror 6 | 视口渲染，100+ 语言懒加载 |
| 插件 | wasmtime | 沙箱执行，插件碰不到文件系统 |

## 试试这些

- [x] 打开一篇 Markdown，右侧预览
- [x] 打开源码文件，语法高亮
- [ ] 用 \`Ctrl + F\` 查找
- [ ] 点预览里的 [[想法]]：双链直接跳过去，左边「反链」会列出谁引用了我

> 代码块、表格、任务列表、删除线都是 GFM 标准。

\`\`\`rust
fn main() {
    println!("hello from Rust");
}
\`\`\`
`,
  [`${DEMO_ROOT}/playground.py`]: `from dataclasses import dataclass


@dataclass
class Note:
    title: str
    tags: list[str]


def collect(notes: list[Note]) -> dict[str, int]:
    counter: dict[str, int] = {}
    for note in notes:
        for tag in note.tags:
            counter[tag] = counter.get(tag, 0) + 1
    return counter


if __name__ == "__main__":
    print(collect([Note("a", ["rust", "ui"]), Note("b", ["rust"])]))
`,
  [`${DEMO_ROOT}/src/widget.tsx`]: `type Props = {
  title: string
  onClose: () => void
}

export function Panel({ title, onClose }: Props) {
  return (
    <section className="panel">
      <header>{title}</header>
      <button onClick={onClose}>关闭</button>
    </section>
  )
}
`,
  [`${DEMO_ROOT}/notes/想法.md`]: `---
tags: [想法, 产品]
---

# 想法池

1. 命令面板（Ctrl+Shift+P）
2. 全文替换（正则）
3. 大纲跳转

外部修改文件时要有提示，不能悄悄覆盖。

写到一半的念头可以挂在 [[索引]] 里，别让它散在各处。 #灵感
`,
  [`${DEMO_ROOT}/notes/索引.md`]: `---
title: 索引
tags: [索引]
---

# 索引

- [[README]] —— 项目说明
- [[想法|产品想法]] —— 还没落地的点子
- [[还没写]] —— 故意留一个未解析的链接

> 未解析的链接在「反链」面板里是虚线，点一下就能新建。
`,
  [`${DEMO_ROOT}/data/sample.csv`]: `name,lang,stars
tauri,rust,92000
codemirror,typescript,6800
wasmtime,rust,17000
`
}

let demoTree: TreeNode[] = [
  {
    name: 'src',
    path: `${DEMO_ROOT}/src`,
    isDir: true,
    size: 0,
    ext: '',
    children: [
      { name: 'widget.tsx', path: `${DEMO_ROOT}/src/widget.tsx`, isDir: false, size: 168, ext: 'tsx' }
    ]
  },
  {
    name: 'notes',
    path: `${DEMO_ROOT}/notes`,
    isDir: true,
    size: 0,
    ext: '',
    children: [
      { name: '索引.md', path: `${DEMO_ROOT}/notes/索引.md`, isDir: false, size: 220, ext: 'md' },
      { name: '想法.md', path: `${DEMO_ROOT}/notes/想法.md`, isDir: false, size: 200, ext: 'md' }
    ]
  },
  {
    name: 'data',
    path: `${DEMO_ROOT}/data`,
    isDir: true,
    size: 0,
    ext: '',
    children: [
      { name: 'sample.csv', path: `${DEMO_ROOT}/data/sample.csv`, isDir: false, size: 78, ext: 'csv' }
    ]
  },
  { name: 'README.md', path: `${DEMO_ROOT}/README.md`, isDir: false, size: 720, ext: 'md' },
  { name: 'playground.py', path: `${DEMO_ROOT}/playground.py`, isDir: false, size: 420, ext: 'py' }
]

const demoEdits: Record<string, string> = {}

/* --- 演示模式下的增删改：直接动内存里的树，让 UI 能独立调试 --- */

function demoChildrenOf(dir: string): TreeNode[] | null {
  if (dir === DEMO_ROOT) return demoTree
  const walk = (nodes: TreeNode[]): TreeNode | null => {
    for (const n of nodes) {
      if (n.path === dir) return n
      const hit = n.children ? walk(n.children) : null
      if (hit) return hit
    }
    return null
  }
  const node = walk(demoTree)
  if (!node || !node.isDir) return null
  if (!node.children) node.children = []
  return node.children
}

function demoTake(path: string): TreeNode | null {
  const parent = parentOf(path)
  const list = demoChildrenOf(parent)
  if (!list) return null
  const idx = list.findIndex(n => n.path === path)
  if (idx < 0) return null
  return list.splice(idx, 1)[0]
}

function demoRepath(node: TreeNode, from: string, to: string) {
  node.path = to
  for (const child of node.children ?? []) {
    demoRepath(child, child.path, `${to}${child.path.slice(from.length)}`)
  }
}

/* ------------------------------------------------------------------ */
/* 命令封装                                                             */
/* ------------------------------------------------------------------ */

export async function openFolderDialog(): Promise<string | null> {
  if (!isTauri) return DEMO_ROOT
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ directory: true, multiple: false, title: '选择笔记文件夹' })
  return typeof picked === 'string' ? picked : null
}

export async function readTree(root: string, depth = 6): Promise<TreeNode[]> {
  if (!isTauri) return demoTree
  return invoke<TreeNode[]>('ws_tree', { root, depth })
}

export async function readFile(path: string): Promise<FilePayload> {
  if (!isTauri) {
    const content = demoEdits[path] ?? demoFiles[path] ?? ''
    return {
      path,
      content,
      encoding: 'UTF-8',
      eol: 'LF',
      size: new Blob([content]).size,
      binary: false,
      mtime: Date.now() / 1000
    }
  }
  return invoke<FilePayload>('file_read', { path })
}

export async function writeFile(
  path: string,
  content: string,
  encoding: string,
  eol: string
): Promise<SaveResult> {
  if (!isTauri) {
    demoEdits[path] = content
    return { size: new Blob([content]).size, mtime: Date.now() / 1000 }
  }
  return invoke<SaveResult>('file_write', { path, content, encoding, eol })
}

export async function createEntry(path: string, kind: 'file' | 'dir'): Promise<void> {
  if (!isTauri) {
    const list = demoChildrenOf(parentOf(path))
    if (!list) throw new Error('目录不存在')
    if (list.some(n => n.path === path)) throw new Error('同名文件已存在')
    const name = baseName(path)
    list.push({
      name,
      path,
      isDir: kind === 'dir',
      size: 0,
      ext: kind === 'dir' ? '' : (name.split('.').pop() ?? '').toLowerCase(),
      children: kind === 'dir' ? [] : null
    })
    if (kind === 'file') demoFiles[path] = ''
    return
  }
  await invoke('file_create', { path, kind: kind === 'dir' ? 'dir' : 'file' })
}

export async function renameEntry(from: string, to: string): Promise<void> {
  if (!isTauri) {
    const node = demoTake(from)
    if (!node) throw new Error('源文件不存在')
    demoRepath(node, from, to)
    node.name = baseName(to)
    demoChildrenOf(parentOf(to))?.push(node)
    if (demoFiles[from] !== undefined) {
      demoFiles[to] = demoFiles[from]
      delete demoFiles[from]
    }
    if (demoEdits[from] !== undefined) {
      demoEdits[to] = demoEdits[from]
      delete demoEdits[from]
    }
    return
  }
  await invoke('file_rename', { from, to })
}

export async function deleteEntry(path: string): Promise<void> {
  if (!isTauri) {
    demoTake(path)
    delete demoFiles[path]
    delete demoEdits[path]
    return
  }
  await invoke('file_delete', { path })
}

/** 复制一份路径到剪贴板（浏览器与桌面端都可用） */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 只取 size/mtime，用来判断磁盘上的文件有没有被外部改动 */
export async function fileStat(path: string): Promise<FileStat> {
  if (!isTauri) {
    const content = demoEdits[path] ?? demoFiles[path]
    if (content === undefined) return { exists: false, size: 0, mtime: 0 }
    return { exists: true, size: new Blob([content]).size, mtime: Date.now() / 1000 }
  }
  return invoke<FileStat>('file_stat', { path })
}

/** 让 Rust 侧监听工作区变化；重复调用会切换监听目录 */
export async function watchRoot(root: string): Promise<void> {
  if (!isTauri) return
  await invoke('watch_root', { root })
}

export { joinPath, parentOf, baseName }

export async function renderMarkdown(markdown: string): Promise<string> {
  if (!isTauri) {
    // 浏览器演示模式：前端兜底渲染，桌面端一律走 comrak
    const { marked } = await import('marked')
    const { default: DOMPurify } = await import('dompurify')
    return DOMPurify.sanitize(await marked.parse(markdown))
  }
  return invoke<string>('md_render', { markdown })
}

/** 图节点：后端已经从全文索引里解析好链接和标签 */
export interface GraphNodePayload {
  path: string
  name: string
  title: string
  tags: string[]
  links: Array<{ target: string; label: string; kind: 'wiki' | 'md'; line: number }>
}

/** 扫一遍全文索引，拿到链接图 + 标签（桌面端专用；演示模式见 lib/graph.ts） */
export async function graphScan(root: string): Promise<{ nodes: GraphNodePayload[]; took: number }> {
  return invoke('graph_scan', { root })
}

export async function touchRecent(path: string, title: string): Promise<void> {
  if (!isTauri) return
  try {
    await invoke('meta_touch', { path, title })
  } catch {
    /* 元数据失败不影响编辑 */
  }
}

export async function listPlugins(): Promise<PluginInfo[]> {
  if (!isTauri) return []
  try {
    return await invoke<PluginInfo[]>('plugin_list')
  } catch {
    return []
  }
}

export async function runPlugin(id: string, input: unknown): Promise<string> {
  if (!isTauri) throw new Error('浏览器模式不支持 WASM 插件，请用 npm run tauri:dev')
  return invoke<string>('plugin_run', { id, input: JSON.stringify(input) })
}

/* ---------------- 插件市场 ---------------- */

/** 拉市场索引文本：桌面端走 Rust（绕开 CORS），浏览器演示模式退回 fetch */
export async function marketFetch(url: string): Promise<string> {
  if (!isTauri) {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  }
  return invoke<string>('market_fetch', { url })
}

export async function installPlugin(id: string, url: string): Promise<PluginInfo[]> {
  if (!isTauri) throw new Error('浏览器模式不支持安装插件')
  return invoke<PluginInfo[]>('plugin_install', { id, url })
}

export async function installPluginZip(path: string): Promise<PluginInfo[]> {
  if (!isTauri) throw new Error('浏览器模式不支持安装插件')
  return invoke<PluginInfo[]>('plugin_install_zip', { path })
}

export async function uninstallPlugin(id: string): Promise<PluginInfo[]> {
  if (!isTauri) throw new Error('浏览器模式不支持卸载插件')
  return invoke<PluginInfo[]>('plugin_uninstall', { id })
}

export async function pluginDir(): Promise<string> {
  if (!isTauri) return '(浏览器演示模式没有插件目录)'
  try {
    return await invoke<string>('plugin_dir')
  } catch {
    return ''
  }
}

/** 选一个 .zip 插件包 */
export async function pickPluginZip(): Promise<string | null> {
  if (!isTauri) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    multiple: false,
    directory: false,
    title: '选择插件包',
    filters: [{ name: '插件包', extensions: ['zip'] }]
  })
  return typeof picked === 'string' ? picked : null
}
