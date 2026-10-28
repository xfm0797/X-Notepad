import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../lib/api'
import { baseName } from '../lib/path'
import { openNewWindow } from '../lib/window'
import { askNewEntry, useWorkspace } from '../store/workspace'

interface Props {
  onClose: () => void
  onOpenPlugins: () => void
}

type Group = '命令' | '文件'

interface Item {
  id: string
  group: Group
  label: string
  hint?: string
  /** 副标题：文件显示所在目录 */
  sub?: string
  /** 返回值一律忽略（有的是 Promise<boolean>、Promise<string|null>） */
  run: () => unknown
}

/** 子序列匹配：query 的字符按顺序出现在 text 里就算命中，连着的加分 */
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let at = 0
  let score = 0
  let streak = 0
  for (const ch of q) {
    const idx = t.indexOf(ch, at)
    if (idx < 0) return null
    streak = idx === at ? streak + 1 : 0
    score += streak * 4 - Math.min(idx - at, 12)
    at = idx + 1
  }
  // 命中同样多的字符时，短名字优先
  return score - t.length * 0.02
}

function flattenFiles(nodes: api.TreeNode[], out: api.TreeNode[] = []): api.TreeNode[] {
  for (const n of nodes) {
    if (n.isDir) {
      if (n.children) flattenFiles(n.children, out)
    } else {
      out.push(n)
    }
    if (out.length > 4000) break
  }
  return out
}

export function CommandPalette({ onClose, onOpenPlugins }: Props) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const tree = useWorkspace(s => s.tree)
  const active = useWorkspace(s => s.active)
  const theme = useWorkspace(s => s.theme)
  const outline = useWorkspace(s => s.outline)

  const files = useMemo(() => flattenFiles(tree), [tree])

  const commands = useMemo<Item[]>(() => {
    const w = useWorkspace.getState()
    const root = w.root
    const list: Item[] = [
      {
        id: 'new-file',
        group: '命令',
        label: '新建文件',
        hint: 'Ctrl+N',
        run: () => (root ? askNewEntry(root, 'file') : undefined)
      },
      {
        id: 'new-dir',
        group: '命令',
        label: '新建文件夹',
        hint: 'Ctrl+Shift+N',
        run: () => (root ? askNewEntry(root, 'dir') : undefined)
      },
      {
        id: 'save',
        group: '命令',
        label: '保存当前文件',
        hint: 'Ctrl+S',
        run: () => w.save()
      },
      { id: 'save-all', group: '命令', label: '保存全部', hint: 'Ctrl+Shift+S', run: () => w.saveAll() },
      {
        id: 'close-tab',
        group: '命令',
        label: '关闭当前标签',
        hint: 'Ctrl+W',
        run: () => (w.active ? w.closeTab(w.active) : undefined)
      },
      { id: 'toggle-preview', group: '命令', label: '切换 Markdown 预览', run: () => w.togglePreview() },
      { id: 'toggle-wrap', group: '命令', label: '切换自动换行', run: () => w.toggleWrap() },
      {
        id: 'toggle-outline',
        group: '命令',
        label: outline ? '隐藏大纲' : '显示大纲',
        run: () => w.toggleOutline()
      },
      {
        id: 'toggle-theme',
        group: '命令',
        label: theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题',
        run: () => w.setTheme(theme === 'dark' ? 'light' : 'dark')
      },
      { id: 'open-folder', group: '命令', label: '打开文件夹', hint: 'Ctrl+O', run: () => w.openFolder() },
      { id: 'refresh', group: '命令', label: '刷新文件树', run: () => w.refreshTree() },
      {
        id: 'new-window',
        group: '命令',
        label: '新建窗口',
        hint: 'Ctrl+Alt+N',
        run: () => openNewWindow({ root: w.root })
      },
      {
        id: 'open-in-new-window',
        group: '命令',
        label: '在新窗口打开当前文件',
        run: () => (active ? openNewWindow({ root: w.root, path: active }) : undefined)
      },
      { id: 'plugins', group: '命令', label: '插件与插件市场', run: onOpenPlugins },
      {
        id: 'search',
        group: '命令',
        label: '全文搜索',
        hint: 'Ctrl+Shift+F',
        run: () => w.toggleSearch()
      },
      {
        id: 'search-regex',
        group: '命令',
        label: '正则查找与替换',
        run: () => {
          w.setSearchRegex(true)
          if (!w.searchOpen) w.toggleSearch()
        }
      },
      { id: 'reindex', group: '命令', label: '重建搜索索引', run: () => w.rebuildIndex() },
      {
        id: 'copy-path',
        group: '命令',
        label: '复制当前文件路径',
        run: () => (active ? api.copyText(active) : undefined)
      }
    ]
    return list
  }, [outline, theme, active, onOpenPlugins])

  const results = useMemo(() => {
    const q = query.trim()
    const scoredCommands = commands
      .map(c => ({ item: c, score: fuzzyScore(q, c.label) }))
      .filter((x): x is { item: Item; score: number } => x.score !== null)
      .map(x => ({ ...x, score: x.score + (q ? 0 : 20) }))

    const scoredFiles = files
      .map(f => {
        const byName = fuzzyScore(q, f.name)
        const byPath = fuzzyScore(q, f.path)
        const best = Math.max(byName ?? -Infinity, byPath === null ? -Infinity : byPath)
        if (!Number.isFinite(best)) return null
        const item: Item = {
          id: `file:${f.path}`,
          group: '文件',
          label: f.name,
          sub: f.path.slice(0, f.path.length - f.name.length).replace(/[\\/]$/, ''),
          run: () => useWorkspace.getState().openFile(f.path)
        }
        // 文件名命中比路径命中更值钱
        return { item, score: best + (byName !== null ? 15 : 0) }
      })
      .filter((x): x is { item: Item; score: number } => x !== null)

    const merge = [...scoredCommands, ...scoredFiles].sort((a, b) => b.score - a.score)
    // 没输入时不铺满一屏文件，先看命令 + 前几个文件
    const cap = q ? 60 : 8
    const picked: Item[] = []
    let fileCount = 0
    for (const { item } of merge) {
      if (item.group === '文件') {
        if (fileCount >= cap) continue
        fileCount++
      }
      picked.push(item)
    }
    return picked
  }, [query, commands, files])

  // 面板刚打开就把焦点放到输入框
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setCursor(0)
  }, [query])

  // 选中项滚进视野
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const runItem = (item: Item | undefined) => {
    if (!item) return
    onClose()
    void item.run()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(c => (results.length ? (c + 1) % results.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(c => (results.length ? (c - 1 + results.length) % results.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runItem(results[cursor])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  let lastGroup: Group | null = null

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="搜索命令或文件…"
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <div className="palette-empty">没有匹配项</div>}
          {results.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null
            lastGroup = item.group
            return (
              <div key={item.id}>
                {header && <div className="palette-group">{header}</div>}
                <div
                  data-idx={i}
                  className={`palette-item${i === cursor ? ' active' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => runItem(item)}
                >
                  <span className="palette-label">{item.label}</span>
                  {item.sub && <span className="palette-sub">{item.sub}</span>}
                  {item.hint && <kbd className="palette-hint">{item.hint}</kbd>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="palette-foot">
          <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
          <span className="palette-foot-hint">
            {active ? baseName(active) : '未打开文件'} · {files.length} 个文件
          </span>
        </div>
      </div>
    </div>
  )
}
