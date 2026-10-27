/**
 * 文件监听：Rust 侧 notify 把事件推过来，这里转成回调。
 * 浏览器演示模式没有 watcher，直接返回空订阅。
 */
import { listen } from '@tauri-apps/api/event'
import { isTauri } from './api'

export interface FsChange {
  kind: 'created' | 'modified' | 'removed' | 'other'
  paths: string[]
}

export async function onFsChange(cb: (change: FsChange) => void): Promise<() => void> {
  if (!isTauri) return () => {}
  try {
    return await listen<FsChange>('ws-change', e => cb(e.payload))
  } catch {
    return () => {}
  }
}
