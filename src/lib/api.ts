/**
 * Tauri invoke 的统一封装。
 *
 * 浏览器里（`npm run dev` 直接开 5173）没有 Rust 后端，
 * 这里退回一份内存里的示例工作区，让 UI 可以独立调试。
 */
import { invoke } from '@tauri-apps/api/core'

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
  [`${DEMO_ROOT}/README.md`]: `# X-Notepad

笔记 + 代码编辑器，一个窗口解决。

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
  [`${DEMO_ROOT}/notes/想法.md`]: `# 想法池

1. 命令面板（Ctrl+Shift+P）
2. 全文替换（正则）
3. 大纲跳转

外部修改文件时要有提示，不能悄悄覆盖。
`,
  [`${DEMO_ROOT}/data/sample.csv`]: `name,lang,stars
tauri,rust,92000
codemirror,typescript,6800
wasmtime,rust,17000
`
}

const demoTree: TreeNode[] = [
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
      { name: '想法.md', path: `${DEMO_ROOT}/notes/想法.md`, isDir: false, size: 96, ext: 'md' }
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
  if (!isTauri) return
  await invoke('file_create', { path, kind })
}

export async function renameEntry(from: string, to: string): Promise<void> {
  if (!isTauri) return
  await invoke('file_rename', { from, to })
}

export async function deleteEntry(path: string): Promise<void> {
  if (!isTauri) return
  await invoke('file_delete', { path })
}

export async function renderMarkdown(markdown: string): Promise<string> {
  if (!isTauri) {
    // 浏览器演示模式：前端兜底渲染，桌面端一律走 comrak
    const { marked } = await import('marked')
    const { default: DOMPurify } = await import('dompurify')
    return DOMPurify.sanitize(await marked.parse(markdown))
  }
  return invoke<string>('md_render', { markdown })
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
