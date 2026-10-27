/**
 * 未保存草稿的兜底存储。
 *
 * 自动保存有 1.2 秒延迟，崩溃/断电就可能丢掉这 1.2 秒的内容，
 * 所以编辑时额外把缓冲区落一份到 localStorage；下次启动如果发现
 * 草稿内容和磁盘上的不一致，就提示用户恢复。
 *
 * 不写进 Rust 侧是因为 localStorage 已经够用且零依赖，
 * 总量限制 3MB（超过就丢最旧的），笔记正文本来就该尽快落盘。
 */
export interface Draft {
  path: string
  name: string
  content: string
  savedContent: string
  encoding: string
  eol: 'LF' | 'CRLF'
  savedAt: number
}

const KEY = 'xnp:drafts'
const MAX_TOTAL = 3 * 1024 * 1024
const MAX_AGE = 7 * 24 * 60 * 60 * 1000

function readMap(): Record<string, Draft> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, Draft>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeMap(map: Record<string, Draft>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    // 超配额就整体放弃草稿，别影响正常编辑
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* ignore */
    }
  }
}

function totalSize(map: Record<string, Draft>): number {
  return Object.values(map).reduce((sum, d) => sum + d.content.length, 0)
}

/** 写入/覆盖某文件的草稿；内容已与磁盘一致时自动清掉 */
export function stash(draft: Draft) {
  const map = readMap()
  const now = Date.now()

  // 顺手清理过期草稿
  for (const [path, d] of Object.entries(map)) {
    if (now - d.savedAt > MAX_AGE) delete map[path]
  }

  if (draft.content === draft.savedContent) {
    delete map[draft.path]
    writeMap(map)
    return
  }

  map[draft.path] = { ...draft, savedAt: now }

  // 超总量：按时间从旧到新丢弃
  while (totalSize(map) > MAX_TOTAL) {
    const oldest = Object.values(map).sort((a, b) => a.savedAt - b.savedAt)[0]
    if (!oldest) break
    delete map[oldest.path]
  }
  writeMap(map)
}

export function drop(path: string) {
  const map = readMap()
  if (!(path in map)) return
  delete map[path]
  writeMap(map)
}

export function all(): Draft[] {
  return Object.values(readMap()).sort((a, b) => b.savedAt - a.savedAt)
}

export function clearAll() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

/** 改名后把草稿键一起搬走 */
export function move(from: string, to: string) {
  const map = readMap()
  if (!(from in map)) return
  const d = map[from]
  delete map[from]
  map[to] = { ...d, path: to, savedAt: Date.now() }
  writeMap(map)
}

/** 删除目录时连带清掉目录下所有草稿 */
export function dropTree(prefix: string) {
  const map = readMap()
  let changed = false
  for (const path of Object.keys(map)) {
    if (path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}\\`)) {
      delete map[path]
      changed = true
    }
  }
  if (changed) writeMap(map)
}
