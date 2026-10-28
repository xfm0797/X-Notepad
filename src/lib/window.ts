/**
 * 多窗口。
 *
 * 每个窗口是独立的 JS 上下文，store 与标签天然隔离；Rust 侧的文件监听按窗口
 * label 分开存（见 `src-tauri/src/watch.rs`），事件也只推给对应窗口。
 *
 * 新窗口要打开哪里，通过 URL 查询串带过去（`?root=…&file=…`），
 * 由 `initialTarget()` 在启动时解析——比在进程里存一张"待打开"表简单。
 */
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from './api'

export interface OpenTarget {
  root: string | null
  file: string | null
}

/** 当前窗口的 label。主窗口是 `main`，新窗口是 `win-1`、`win-2`… */
export function currentLabel(): string {
  if (!isTauri) return 'browser'
  try {
    return getCurrentWindow().label
  } catch {
    return 'main'
  }
}

/** 启动参数：只有新窗口才会带 */
export function initialTarget(): OpenTarget {
  if (typeof location === 'undefined') return { root: null, file: null }
  try {
    const params = new URLSearchParams(location.search)
    const root = params.get('root')
    const file = params.get('file')
    return { root: root || null, file: file || null }
  } catch {
    return { root: null, file: null }
  }
}

/** 新开一个窗口。浏览器演示模式退化成新标签页，参数照带 */
export async function openNewWindow(opts: { root?: string | null; path?: string | null } = {}): Promise<void> {
  const root = opts.root ?? null
  const path = opts.path ?? null
  if (!isTauri) {
    const url = new URL(location.href)
    if (root) url.searchParams.set('root', root)
    if (path) url.searchParams.set('file', path)
    window.open(url.toString(), '_blank', 'noopener')
    return
  }
  await invoke('window_new', { root, path })
}
