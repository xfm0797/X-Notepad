import { create } from 'zustand'
import * as api from '../lib/api'

export interface Doc {
  path: string
  name: string
  content: string
  /** 上次落盘的内容，用来算 dirty */
  savedContent: string
  encoding: string
  eol: 'LF' | 'CRLF'
  binary: boolean
  size: number
  mtime: number
}

type Theme = 'dark' | 'light'

interface WorkspaceState {
  root: string | null
  tree: api.TreeNode[]
  docs: Record<string, Doc>
  tabs: string[]
  active: string | null
  preview: boolean
  wrap: boolean
  theme: Theme
  busy: boolean
  message: string

  openFolder: () => Promise<void>
  refreshTree: () => Promise<void>
  openFile: (path: string) => Promise<void>
  activate: (path: string) => void
  closeTab: (path: string) => void
  edit: (path: string, content: string) => void
  save: (path?: string) => Promise<boolean>
  saveAll: () => Promise<void>
  togglePreview: () => void
  toggleWrap: () => void
  setTheme: (t: Theme) => void
  setMessage: (m: string) => void
  isDirty: (path: string) => boolean
}

const storedTheme = (): Theme => {
  const v = localStorage.getItem('xnp:theme')
  return v === 'light' ? 'light' : 'dark'
}

/** 自动保存定时器：按 path 各一个 */
const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const AUTOSAVE_DELAY = 1200

function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  localStorage.setItem('xnp:theme', theme)
}

applyTheme(storedTheme())

export const useWorkspace = create<WorkspaceState>()((set, get) => ({
  root: null,
  tree: [],
  docs: {},
  tabs: [],
  active: null,
  preview: true,
  wrap: true,
  theme: storedTheme(),
  busy: false,
  message: '',

  isDirty: (path) => {
    const doc = get().docs[path]
    return !!doc && doc.content !== doc.savedContent
  },

  setMessage: (message) => set({ message }),

  openFolder: async () => {
    const root = await api.openFolderDialog()
    if (!root) return
    set({ busy: true, root })
    try {
      const tree = await api.readTree(root)
      set({ tree, tabs: [], docs: {}, active: null, message: `已打开 ${root}` })
    } catch (e) {
      set({ message: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  refreshTree: async () => {
    const root = get().root
    if (!root) return
    try {
      set({ tree: await api.readTree(root) })
    } catch (e) {
      set({ message: String(e) })
    }
  },

  openFile: async (path) => {
    const existing = get().docs[path]
    if (existing) {
      set({ active: path })
      return
    }
    try {
      const file = await api.readFile(path)
      const doc: Doc = {
        path,
        name: baseName(path),
        content: file.content,
        savedContent: file.content,
        encoding: file.encoding,
        eol: file.eol,
        binary: file.binary,
        size: file.size,
        mtime: file.mtime
      }
      set((s) => ({
        docs: { ...s.docs, [path]: doc },
        tabs: s.tabs.includes(path) ? s.tabs : [...s.tabs, path],
        active: path,
        // 打开 Markdown 自动开预览，代码文件自动关
        preview: path.toLowerCase().endsWith('.md')
      }))
      void api.touchRecent(path, doc.name)
    } catch (e) {
      set({ message: String(e).replace(/^Error:\s*/, '') })
    }
  },

  activate: (path) => set({ active: path, preview: path.toLowerCase().endsWith('.md') ? get().preview : false }),

  closeTab: (path) => {
    const timer = autosaveTimers.get(path)
    if (timer) {
      clearTimeout(timer)
      autosaveTimers.delete(path)
    }
    set((s) => {
      const tabs = s.tabs.filter(t => t !== path)
      const docs = { ...s.docs }
      delete docs[path]
      const active = s.active === path ? tabs[tabs.length - 1] ?? null : s.active
      return { tabs, docs, active }
    })
  },

  edit: (path, content) => {
    set((s) => {
      const doc = s.docs[path]
      if (!doc) return s
      return { docs: { ...s.docs, [path]: { ...doc, content } } }
    })
    const prev = autosaveTimers.get(path)
    if (prev) clearTimeout(prev)
    autosaveTimers.set(
      path,
      setTimeout(() => {
        autosaveTimers.delete(path)
        void get().save(path)
      }, AUTOSAVE_DELAY)
    )
  },

  save: async (path) => {
    const target = path ?? get().active
    if (!target) return false
    const doc = get().docs[target]
    if (!doc || doc.binary) return false
    if (doc.content === doc.savedContent) return true
    try {
      const res = await api.writeFile(target, doc.content, doc.encoding, doc.eol)
      set((s) => ({
        docs: { ...s.docs, [target]: { ...s.docs[target], savedContent: doc.content, size: res.size, mtime: res.mtime } },
        message: `已保存 ${doc.name}`
      }))
      return true
    } catch (e) {
      set({ message: `保存失败：${String(e).replace(/^Error:\s*/, '')}` })
      return false
    }
  },

  saveAll: async () => {
    for (const path of get().tabs) {
      if (get().isDirty(path)) await get().save(path)
    }
  },

  togglePreview: () => set((s) => ({ preview: !s.preview })),
  toggleWrap: () => set((s) => ({ wrap: !s.wrap })),
  setTheme: (theme) => {
    applyTheme(theme)
    set({ theme })
  }
}))
