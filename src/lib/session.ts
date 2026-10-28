/**
 * 会话：记住"你在哪"——上次的工作区、开着的标签、激活项、光标位置。
 *
 * 和 `drafts.ts` 分工不同：
 * - 草稿兜的是**没保存的内容**（进程被强杀时把缓冲区捞回来）
 * - 会话兜的是**位置**（正常退出，下次打开还在原来那一页）
 *
 * 光标变化很频繁，所以只放在内存里，跟着 400ms 的防抖一起落盘。
 */
import { isUnder } from './path'

const KEY = 'xnp:session:v1'
const MAX_TABS = 30
const WRITE_DELAY = 400

export interface SessionState {
  root: string | null
  tabs: string[]
  active: string | null
  preview: boolean
  wrap: boolean
  outline: boolean
  /** path → 光标 offset */
  cursors: Record<string, number>
}

const EMPTY: SessionState = {
  root: null,
  tabs: [],
  active: null,
  preview: true,
  wrap: true,
  outline: false,
  cursors: {}
}

let memory: SessionState = { ...EMPTY }
let loaded = false
let timer: ReturnType<typeof setTimeout> | undefined

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<SessionState>
    memory = {
      root: typeof parsed.root === 'string' ? parsed.root : null,
      tabs: Array.isArray(parsed.tabs) ? parsed.tabs.filter(t => typeof t === 'string').slice(0, MAX_TABS) : [],
      active: typeof parsed.active === 'string' ? parsed.active : null,
      preview: parsed.preview !== false,
      wrap: parsed.wrap !== false,
      outline: parsed.outline === true,
      cursors:
        parsed.cursors && typeof parsed.cursors === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.cursors).filter(([, v]) => typeof v === 'number' && v >= 0)
            )
          : {}
    }
  } catch {
    memory = { ...EMPTY }
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    flushSession()
  }, WRITE_DELAY)
}

/** 立即落盘（关窗前调用，别把最后 400ms 的改动丢了） */
export function flushSession(): void {
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  try {
    if (!memory.root) {
      localStorage.removeItem(KEY)
      return
    }
    localStorage.setItem(KEY, JSON.stringify(memory))
  } catch {
    // 存储满 / 隐私模式：会话丢了不影响使用
  }
}

/** 读上次的会话；没有就返回 null */
export function readSession(): SessionState | null {
  load()
  if (!memory.root || !memory.tabs.length) return null
  return memory
}

/** 更新会话（合并式，只传变化的字段） */
export function rememberSession(patch: Partial<SessionState>): void {
  load()
  if (!patch.root && !memory.root) return
  const tabs = (patch.tabs ?? memory.tabs).slice(0, MAX_TABS)
  memory = { ...memory, ...patch, tabs }
  // 光标只为还开着的标签留着，否则换工作区之后会越攒越多
  const keep = new Set(tabs)
  for (const p of Object.keys(memory.cursors)) {
    if (!keep.has(p)) delete memory.cursors[p]
  }
  schedule()
}

export function cursorOf(path: string): number {
  load()
  return memory.cursors[path] ?? 0
}

export function rememberCursor(path: string, pos: number): void {
  load()
  if (memory.cursors[path] === pos) return
  memory.cursors[path] = pos
  schedule()
}

export function dropCursor(path: string): void {
  load()
  if (!(path in memory.cursors)) return
  delete memory.cursors[path]
  schedule()
}

/** 目录改名 / 删除时连带清掉下面的光标 */
export function dropCursorTree(prefix: string): void {
  load()
  for (const p of Object.keys(memory.cursors)) {
    if (p === prefix || isUnder(p, prefix)) delete memory.cursors[p]
  }
  schedule()
}

/** 改名：单个文件或整个目录下的光标一起前缀映射 */
export function remapCursors(from: string, to: string): void {
  load()
  const next: Record<string, number> = {}
  let changed = false
  for (const [p, pos] of Object.entries(memory.cursors)) {
    if (p === from || isUnder(p, from)) {
      next[`${to}${p.slice(from.length)}`] = pos
      changed = true
    } else {
      next[p] = pos
    }
  }
  if (!changed) return
  memory.cursors = next
  schedule()
}

export function clearSession(): void {
  memory = { ...EMPTY, cursors: {} }
  loaded = true
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}
