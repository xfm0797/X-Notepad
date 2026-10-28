import { create } from 'zustand'
import * as api from '../lib/api'
import * as drafts from '../lib/drafts'
import * as search from '../lib/search'
import * as session from '../lib/session'
import { baseName, isUnder, joinPath, parentOf, validateName } from '../lib/path'
import { ask, choose, confirm } from './dialogs'
import { isMarkdown } from '../lib/lang'

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
  /** 磁盘上的文件被别的程序改过了 */
  external: boolean
  /** 磁盘上的文件已经不在了 */
  gone: boolean
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
  /** Markdown 大纲面板 */
  outline: boolean
  /** 一次性跳转指令：非空时编辑器把选区挪过去 */
  jump: { path: string; pos: number; nonce: number } | null
  theme: Theme
  busy: boolean
  message: string

  /* 全文搜索 */
  searchOpen: boolean
  searchQuery: string
  searchCase: boolean
  /** 正则模式（FTS5 表达不了正则，走后端全表扫） */
  searchRegex: boolean
  /** 替换框的内容 */
  searchReplace: string
  /** 替换进行中（替换要跑一会儿，按钮得禁用） */
  replacing: boolean
  searchHits: search.SearchHit[]
  searchBusy: boolean
  searchTook: number
  searchError: string
  indexStatus: search.IndexStatus | null
  indexing: boolean

  openFolder: () => Promise<void>
  refreshTree: () => Promise<void>
  openFile: (path: string) => Promise<void>
  activate: (path: string) => void
  closeTab: (path: string) => Promise<void>
  edit: (path: string, content: string) => void
  save: (path?: string) => Promise<boolean>
  saveAll: () => Promise<void>
  togglePreview: () => void
  toggleWrap: () => void
  toggleOutline: () => void
  jumpTo: (path: string, pos: number) => void
  setTheme: (t: Theme) => void
  setMessage: (m: string) => void
  isDirty: (path: string) => boolean

  /* 全文搜索 */
  toggleSearch: () => void
  setSearchQuery: (q: string) => void
  setSearchCase: (v: boolean) => void
  setSearchRegex: (v: boolean) => void
  setSearchReplace: (v: string) => void
  runSearch: () => Promise<void>
  /** 全库替换（先 dry-run 报数量，确认后再落盘） */
  replaceAll: () => Promise<void>
  /** silent=true 时不改状态栏提示（自动建索引时用） */
  rebuildIndex: (silent?: boolean) => Promise<void>
  refreshIndexStatus: () => Promise<void>
  openHit: (hit: search.SearchHit) => Promise<void>
  /** 从磁盘重新读回若干文件（替换 / 外部改动之后用） */
  reloadMany: (paths: string[]) => Promise<void>

  /* 工作区 */
  /** 按指定目录打开（新窗口带参数启动时用） */
  openWorkspaceAt: (root: string, file?: string | null) => Promise<void>

  /* 文件树操作 */
  newEntry: (dir: string, name: string, kind: 'file' | 'dir') => Promise<string | null>
  renameEntry: (path: string, name: string) => Promise<string | null>
  removeEntry: (path: string) => Promise<boolean>

  /* 外部修改 */
  handleFsChange: (paths: string[]) => Promise<void>
  reloadFromDisk: (path: string) => Promise<void>
  keepMine: (path: string) => Promise<void>

  /* 启动恢复 */
  restoreSession: () => Promise<void>
  restoreDrafts: () => Promise<void>
}

const storedTheme = (): Theme => {
  const v = localStorage.getItem('xnp:theme')
  return v === 'light' ? 'light' : 'dark'
}

/** 自动保存定时器：按 path 各一个 */
const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** 草稿落盘定时器，比自动保存更快，用来兜住崩溃 */
const stashTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** 自己刚写过的文件，短时间内忽略 watcher 事件 */
const lastWrite = new Map<string, number>()

/** 搜索框防抖 */
let searchTimer: ReturnType<typeof setTimeout> | undefined
/** 请求序号：慢的那个回来时不能覆盖新结果 */
let searchSeq = 0

const AUTOSAVE_DELAY = 1200
const STASH_DELAY = 600
const SELF_WRITE_WINDOW = 1500

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  localStorage.setItem('xnp:theme', theme)
}

applyTheme(storedTheme())

function clearTimers(map: Map<string, ReturnType<typeof setTimeout>>, path: string) {
  const t = map.get(path)
  if (t) {
    clearTimeout(t)
    map.delete(path)
  }
}

function findNode(nodes: api.TreeNode[], path: string): api.TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n
    const hit = n.children ? findNode(n.children, path) : null
    if (hit) return hit
  }
  return null
}

export const useWorkspace = create<WorkspaceState>()((set, get) => ({
  root: null,
  tree: [],
  docs: {},
  tabs: [],
  active: null,
  preview: true,
  wrap: true,
  outline: false,
  jump: null,
  theme: storedTheme(),
  busy: false,
  message: '',
  searchOpen: false,
  searchQuery: '',
  searchCase: false,
  searchRegex: false,
  searchReplace: '',
  replacing: false,
  searchHits: [],
  searchBusy: false,
  searchTook: 0,
  searchError: '',
  indexStatus: null,
  indexing: false,

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
      // 桌面端顺带挂上文件监听，外部改动才能提示
      void api.watchRoot(root)
      // 索引后台重建，不挡打开文件夹
      void get().rebuildIndex(true)
    } catch (e) {
      set({ message: String(e).replace(/^Error:\s*/, '') })
    } finally {
      set({ busy: false })
    }
  },

  openWorkspaceAt: async (root, file) => {
    set({ busy: true })
    try {
      const tree = await api.readTree(root)
      set({ root, tree, tabs: [], docs: {}, active: null, message: `已打开 ${root}` })
      void api.watchRoot(root)
      if (file) await get().openFile(file)
      void get().rebuildIndex(true)
    } catch (e) {
      set({ message: String(e).replace(/^Error:\s*/, '') })
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
      set({ message: String(e).replace(/^Error:\s*/, '') })
    }
  },

  openFile: async (path) => {
    const existing = get().docs[path]
    if (existing) {
      set({ active: path, preview: isMarkdown(baseName(path).split('.').pop() ?? '') })
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
        mtime: file.mtime,
        external: false,
        gone: false
      }
      set((s) => ({
        docs: { ...s.docs, [path]: doc },
        tabs: s.tabs.includes(path) ? s.tabs : [...s.tabs, path],
        active: path,
        // 打开 Markdown 自动开预览，代码文件自动关
        preview: isMarkdown(baseName(path).split('.').pop() ?? '')
      }))
      void api.touchRecent(path, doc.name)
    } catch (e) {
      set({ message: String(e).replace(/^Error:\s*/, '') })
    }
  },

  activate: (path) => {
    const ext = baseName(path).split('.').pop() ?? ''
    set({ active: path, preview: isMarkdown(ext) ? get().preview : false })
  },

  closeTab: async (path) => {
    const doc = get().docs[path]
    if (doc && doc.content !== doc.savedContent) {
      const pick = await choose({
        title: '关闭前保存？',
        message: `${doc.name} 有未保存的修改。`,
        options: [
          { label: '保存并关闭', value: 'save', primary: true },
          { label: '不保存', value: 'discard', danger: true }
        ]
      })
      if (!pick) return
      if (pick === 'save' && !(await get().save(path))) return
    }

    clearTimers(autosaveTimers, path)
    clearTimers(stashTimers, path)
    drafts.drop(path)
    session.dropCursor(path)

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

    // 1.2 秒后自动保存
    const prev = autosaveTimers.get(path)
    if (prev) clearTimeout(prev)
    autosaveTimers.set(
      path,
      setTimeout(() => {
        autosaveTimers.delete(path)
        void get().save(path)
      }, AUTOSAVE_DELAY)
    )

    // 600 毫秒后落一份草稿，崩溃时能捞回来
    const prevStash = stashTimers.get(path)
    if (prevStash) clearTimeout(prevStash)
    stashTimers.set(
      path,
      setTimeout(() => {
        stashTimers.delete(path)
        const doc = get().docs[path]
        if (!doc || doc.content === doc.savedContent) return
        drafts.stash({
          path: doc.path,
          name: doc.name,
          content: doc.content,
          savedContent: doc.savedContent,
          encoding: doc.encoding,
          eol: doc.eol,
          savedAt: Date.now()
        })
      }, STASH_DELAY)
    )
  },

  save: async (path) => {
    const target = path ?? get().active
    if (!target) return false
    const doc = get().docs[target]
    if (!doc || doc.binary) return false
    if (doc.content === doc.savedContent && !doc.gone) return true
    try {
      lastWrite.set(target, Date.now())
      const res = await api.writeFile(target, doc.content, doc.encoding, doc.eol)
      set((s) => ({
        docs: {
          ...s.docs,
          [target]: {
            ...s.docs[target],
            savedContent: doc.content,
            size: res.size,
            mtime: res.mtime,
            external: false,
            gone: false
          }
        },
        message: `已保存 ${doc.name}`
      }))
      drafts.drop(target)
      // 存完顺手把这篇重新灌进全文索引（失败不影响保存本身）
      void search.updateIndex(target, get().root ?? undefined).catch(() => {})
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

  /* ---------------- 文件树操作 ---------------- */

  newEntry: async (dir, name, kind) => {
    const err = validateName(name)
    if (err) {
      set({ message: err })
      return null
    }
    const full = joinPath(dir, name)
    try {
      await api.createEntry(full, kind)
      await get().refreshTree()
      set({ message: `已创建 ${name}` })
      if (kind === 'file') await get().openFile(full)
      return full
    } catch (e) {
      set({ message: `创建失败：${String(e).replace(/^Error:\s*/, '')}` })
      return null
    }
  },

  renameEntry: async (path, name) => {
    const err = validateName(name)
    if (err) {
      set({ message: err })
      return null
    }
    const to = joinPath(parentOf(path), name)
    if (to === path) return path
    const wasDir = findNode(get().tree, path)?.isDir ?? false
    try {
      await api.renameEntry(path, to)
    } catch (e) {
      set({ message: `重命名失败：${String(e).replace(/^Error:\s*/, '')}` })
      return null
    }

    // 目录改名要连带映射它下面已打开的文档
    const remap = (p: string) => (isUnder(p, path) ? `${to}${p.slice(path.length)}` : p)

    set((s) => {
      const docs: Record<string, Doc> = {}
      for (const [p, doc] of Object.entries(s.docs)) {
        const np = remap(p)
        docs[np] = np === p ? doc : { ...doc, path: np, name: baseName(np) }
      }
      const tabs = Array.from(new Set(s.tabs.map(remap)))
      const active = s.active ? remap(s.active) : null
      return { docs, tabs, active, message: `已重命名为 ${name}` }
    })

    drafts.move(path, to)
    // 光标跟着走（目录改名时连子树一起前缀映射）
    session.remapCursors(path, to)
    await get().refreshTree()

    // 索引跟着改名走：目录改名整棵重灌（前缀映射太啰嗦），单文件挪一条
    if (wasDir) {
      void get().rebuildIndex(true)
    } else {
      void search
        .removeIndex(path)
        .then(() => search.updateIndex(to, get().root ?? undefined))
        .catch(() => {})
    }
    return to
  },

  removeEntry: async (path) => {
    const name = baseName(path)
    const node = findNode(get().tree, path)
    const isDir = node?.isDir ?? false
    const okay = await confirm({
      title: '删除',
      message: `确定删除「${name}」吗？${isDir ? '\n目录里的内容会一起删除。' : ''}\n此操作不可撤销。`,
      confirmText: '删除',
      danger: true
    })
    if (!okay) return false

    try {
      await api.deleteEntry(path)
    } catch (e) {
      set({ message: `删除失败：${String(e).replace(/^Error:\s*/, '')}` })
      return false
    }

    // 关掉受影响的标签页（不再询问，用户刚确认过删除）
    set((s) => {
      const docs = { ...s.docs }
      const tabs = s.tabs.filter(t => {
        if (!isUnder(t, path)) return true
        delete docs[t]
        clearTimers(autosaveTimers, t)
        clearTimers(stashTimers, t)
        return false
      })
      const active = s.active && isUnder(s.active, path) ? tabs[tabs.length - 1] ?? null : s.active
      return { docs, tabs, active, message: `已删除 ${name}` }
    })

    drafts.dropTree(path)
    session.dropCursorTree(path)
    await get().refreshTree()
    void search.removeIndex(path).catch(() => {})
    return true
  },

  /* ---------------- 外部修改 ---------------- */

  handleFsChange: async (paths) => {
    const state = get()
    if (!state.root) return

    // 树结构变了就刷一次，路径级事件可能很多，交给调用方做去抖
    await state.refreshTree()

    for (const doc of Object.values(state.docs)) {
      const hit = paths.some(p => p === doc.path)
      if (!hit) continue
      const wrote = lastWrite.get(doc.path) ?? 0
      if (Date.now() - wrote < SELF_WRITE_WINDOW) continue

      const st = await api.fileStat(doc.path)
      if (!st.exists) {
        set(s => (s.docs[doc.path] ? { docs: { ...s.docs, [doc.path]: { ...s.docs[doc.path], gone: true } } } : s))
        continue
      }
      if (st.mtime !== doc.mtime || st.size !== doc.size) {
        set(s =>
          s.docs[doc.path]
            ? { docs: { ...s.docs, [doc.path]: { ...s.docs[doc.path], external: true } } }
            : s
        )
      }
    }

    // 索引跟着磁盘走：文件改了重灌，删了摘掉，目录事件 Rust 侧自己会忽略
    for (const p of paths) {
      void search.updateIndex(p, state.root).catch(() => {})
    }
  },

  reloadFromDisk: async (path) => {
    try {
      const file = await api.readFile(path)
      set(s => {
        const doc = s.docs[path]
        if (!doc) return s
        return {
          docs: {
            ...s.docs,
            [path]: {
              ...doc,
              content: file.content,
              savedContent: file.content,
              encoding: file.encoding,
              eol: file.eol,
              size: file.size,
              mtime: file.mtime,
              external: false,
              gone: false
            }
          },
          message: `已重新载入 ${doc.name}`
        }
      })
      drafts.drop(path)
    } catch (e) {
      set({ message: `重新载入失败：${String(e).replace(/^Error:\s*/, '')}` })
    }
  },

  keepMine: async (path) => {
    // 记下磁盘当前状态，避免同一份外部修改反复弹提示
    const st = await api.fileStat(path)
    set(s => {
      const doc = s.docs[path]
      if (!doc) return s
      return {
        docs: {
          ...s.docs,
          [path]: { ...doc, external: false, gone: false, mtime: st.mtime, size: st.size }
        },
        message: '保留当前编辑内容，下次保存会覆盖磁盘文件'
      }
    })
  },

  /* ---------------- 启动恢复 ---------------- */

  restoreSession: async () => {
    const saved = session.readSession()
    if (!saved || !saved.root) return
    // 目录可能被移走 / 删掉了，读不出来就当没有会话，老老实实显示欢迎页
    let tree: api.TreeNode[]
    try {
      tree = await api.readTree(saved.root)
    } catch {
      session.clearSession()
      return
    }

    set({ root: saved.root, tree })
    void api.watchRoot(saved.root)

    // 逐个把标签打开：文件被删掉的那些，openFile 自己会跳过并提示
    let restored = 0
    for (const path of saved.tabs) {
      await get().openFile(path)
      if (get().docs[path]) restored++
    }

    const tabs = get().tabs
    // preview 会被 openFile 按扩展名覆盖，所以放在循环之后再还原
    set({
      active: saved.active && tabs.includes(saved.active) ? saved.active : tabs[tabs.length - 1] ?? null,
      preview: saved.preview,
      wrap: saved.wrap,
      outline: saved.outline,
      message: restored ? `已恢复上次的 ${restored} 个标签` : ''
    })
    void get().rebuildIndex(true)
  },

  /* ---------------- 崩溃恢复 ---------------- */

  restoreDrafts: async () => {
    const list = drafts.all().filter(d => d.content !== d.savedContent)
    if (!list.length) {
      drafts.clearAll()
      return
    }

    const preview = list.slice(0, 5).map(d => `· ${d.name}`).join('\n')
    const more = list.length > 5 ? `\n… 还有 ${list.length - 5} 篇` : ''
    const pick = await choose({
      title: '恢复未保存的内容',
      message: `上次退出时有 ${list.length} 篇笔记没来得及保存到磁盘：\n\n${preview}${more}`,
      options: [
        { label: '恢复', value: 'restore', primary: true },
        { label: '全部丢弃', value: 'drop', danger: true }
      ]
    })
    if (pick !== 'restore') {
      drafts.clearAll()
      return
    }

    for (const d of list) {
      let disk: api.FilePayload | null = null
      try {
        disk = await api.readFile(d.path)
      } catch {
        disk = null
      }
      const doc: Doc = {
        path: d.path,
        name: d.name,
        content: d.content,
        savedContent: disk ? disk.content : d.savedContent,
        encoding: disk ? disk.encoding : d.encoding,
        eol: disk ? disk.eol : d.eol,
        binary: false,
        size: disk ? disk.size : 0,
        mtime: disk ? disk.mtime : 0,
        external: false,
        gone: !disk
      }
      set(s => ({
        docs: { ...s.docs, [d.path]: doc },
        tabs: s.tabs.includes(d.path) ? s.tabs : [...s.tabs, d.path],
        active: d.path
      }))
    }
    set({ message: `已恢复 ${list.length} 篇草稿，记得保存` })
  },

  /* ---------------- 全文搜索 ---------------- */

  toggleSearch: () => {
    const open = !get().searchOpen
    set({ searchOpen: open })
    if (!open) return
    void get().refreshIndexStatus()
    // 关掉再打开时把上次的查询重跑一遍，别让面板看起来是空的
    if (get().searchQuery.trim()) void get().runSearch()
  },

  setSearchQuery: (searchQuery) => {
    set({ searchQuery })
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchTimer = undefined
      void get().runSearch()
    }, 180)
  },

  setSearchCase: (searchCase) => {
    set({ searchCase })
    if (get().searchQuery.trim()) void get().runSearch()
  },

  setSearchRegex: (searchRegex) => {
    set({ searchRegex })
    if (get().searchQuery.trim()) void get().runSearch()
  },

  setSearchReplace: (searchReplace) => set({ searchReplace }),

  replaceAll: async () => {
    const { searchQuery, searchReplace, searchRegex, searchCase, root } = get()
    // 正则里前后空格有意义，只有关键词模式才 trim
    const pattern = searchRegex ? searchQuery : searchQuery.trim()
    if (!pattern) {
      set({ searchError: '先输入要查找的内容', searchOpen: true })
      return
    }
    if (searchRegex) {
      // 正则先在本地编译一次：错误立刻反馈，不用等一轮 IPC
      try {
        search.compilePattern(pattern, searchCase)
      } catch (e) {
        set({ searchError: String(e).replace(/^Error:\s*/, '') })
        return
      }
    }

    // 先把编辑器里的改动落盘，否则替换写完磁盘又被自动保存盖回去
    await get().saveAll()
    const skip = Object.values(get().docs)
      .filter(d => d.content !== d.savedContent)
      .map(d => d.path)

    const base: search.ReplaceOptions = {
      regex: searchRegex,
      caseSensitive: searchCase,
      root: root ?? undefined,
      skip
    }

    set({ replacing: true, searchError: '' })
    try {
      const dry = await search.replaceAll(pattern, searchReplace, { ...base, dryRun: true })
      if (!dry.files) {
        set({
          replacing: false,
          searchError: '',
          message: dry.skipped.length
            ? '这些文件有未保存的修改，先保存再替换'
            : `没有找到「${pattern}」`
        })
        return
      }

      const preview = dry.changed
        .slice(0, 6)
        .map(c => `· ${c.name}（${c.count} 处）`)
        .join('\n')
      const more = dry.changed.length > 6 ? `\n… 还有 ${dry.changed.length - 6} 个文件` : ''
      const skippedNote = dry.skipped.length
        ? `\n\n跳过 ${dry.skipped.length} 个有未保存修改的文件。`
        : ''
      const okay = await confirm({
        title: '全部替换',
        message: `将在 ${dry.files} 个文件里替换 ${dry.replacements} 处：\n\n${preview}${more}${skippedNote}\n\n此操作没有撤销，确定替换吗？`,
        confirmText: '替换',
        danger: true
      })
      if (!okay) {
        set({ replacing: false })
        return
      }

      const report = await search.replaceAll(pattern, searchReplace, base)
      await get().reloadMany(report.changed.map(c => c.path))
      set({
        replacing: false,
        message: `已替换 ${report.files} 个文件 · ${report.replacements} 处`
      })
      if (get().searchQuery.trim()) void get().runSearch()
    } catch (e) {
      set({ replacing: false, searchError: String(e).replace(/^Error:\s*/, '') })
    }
  },

  reloadMany: async (paths) => {
    for (const path of paths) {
      if (!get().docs[path]) continue
      try {
        const file = await api.readFile(path)
        set(s => {
          const doc = s.docs[path]
          if (!doc) return s
          return {
            docs: {
              ...s.docs,
              [path]: {
                ...doc,
                content: file.content,
                savedContent: file.content,
                encoding: file.encoding,
                eol: file.eol,
                size: file.size,
                mtime: file.mtime,
                external: false,
                gone: false
              }
            }
          }
        })
        drafts.drop(path)
      } catch {
        /* 读不回来就算了，下次打开会重新读 */
      }
    }
  },

  runSearch: async () => {
    // 正则里前后空格是有意义的，只有关键词模式才 trim
    const raw = get().searchQuery
    const query = get().searchRegex ? raw : raw.trim()
    const seq = ++searchSeq
    if (!query) {
      set({ searchHits: [], searchTook: 0, searchError: '', searchBusy: false })
      return
    }
    set({ searchBusy: true, searchError: '' })
    const t0 = Date.now()
    try {
      const hits = await search.queryIndex(query, {
        caseSensitive: get().searchCase,
        regex: get().searchRegex,
        root: get().root ?? undefined,
        limit: 200
      })
      // 慢请求回来晚了就别覆盖新结果
      if (seq !== searchSeq) return
      set({ searchHits: hits, searchBusy: false, searchTook: Date.now() - t0 })
    } catch (e) {
      if (seq !== searchSeq) return
      set({
        searchHits: [],
        searchBusy: false,
        searchTook: 0,
        searchError: String(e).replace(/^Error:\s*/, '')
      })
    }
  },

  rebuildIndex: async (silent) => {
    const root = get().root
    if (!root) return
    set({ indexing: true, searchError: '' })
    try {
      const report = await search.buildIndex(root)
      set({
        indexStatus: report,
        indexing: false,
        ...(silent ? {} : { message: `已索引 ${report.files} 个文件（${report.ms ?? 0} ms）` })
      })
      if (get().searchQuery.trim()) void get().runSearch()
    } catch (e) {
      set({
        indexing: false,
        searchError: String(e).replace(/^Error:\s*/, ''),
        ...(silent ? {} : { message: '建立索引失败' })
      })
    }
  },

  refreshIndexStatus: async () => {
    try {
      const st = await search.indexStatus()
      if (st) set({ indexStatus: st })
    } catch {
      /* 索引状态拿不到不影响搜索面板本身 */
    }
  },

  openHit: async (hit) => {
    await get().openFile(hit.path)
    const content = get().docs[hit.path]?.content ?? ''
    get().jumpTo(hit.path, search.offsetOf(content, hit.line, hit.column))
  },

  togglePreview: () => set((s) => ({ preview: !s.preview })),
  toggleWrap: () => set((s) => ({ wrap: !s.wrap })),
  toggleOutline: () => set((s) => ({ outline: !s.outline })),
  // nonce 是为了让"同一个位置跳两次"也能触发编辑器的 effect
  jumpTo: (path, pos) => set((s) => ({ jump: { path, pos, nonce: (s.jump?.nonce ?? 0) + 1 } })),
  setTheme: (theme) => {
    applyTheme(theme)
    set({ theme })
  }
}))

/** 供 UI 直接调用的"输入名字再新建"流程 */
export async function askNewEntry(dir: string, kind: 'file' | 'dir') {
  const name = await ask({
    title: kind === 'dir' ? '新建文件夹' : '新建文件',
    message: dir,
    label: '名称',
    value: kind === 'dir' ? '新建文件夹' : '未命名.md',
    confirmText: '创建',
    validate: validateName
  })
  if (!name) return null
  return useWorkspace.getState().newEntry(dir, name, kind)
}

/** 重命名入口：默认带上当前文件名并全选 */
export async function askRename(path: string) {
  const name = await ask({
    title: '重命名',
    message: parentOf(path),
    label: '新名称',
    value: baseName(path),
    confirmText: '重命名',
    validate: validateName
  })
  if (!name) return null
  return useWorkspace.getState().renameEntry(path, name)
}
