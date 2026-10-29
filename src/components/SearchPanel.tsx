import { useEffect, useMemo, useRef, useState } from 'react'
import { groupHits } from '../lib/dirgroup'
import { useWorkspace } from '../store/workspace'

function stamp(secs: number): string {
  if (!secs) return '还没建过索引'
  const d = new Date(secs * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 全文搜索结果抽屉（Ctrl+Shift+F） */
export function SearchPanel() {
  const query = useWorkspace(s => s.searchQuery)
  const setQuery = useWorkspace(s => s.setSearchQuery)
  const caseSensitive = useWorkspace(s => s.searchCase)
  const setCase = useWorkspace(s => s.setSearchCase)
  const regex = useWorkspace(s => s.searchRegex)
  const setRegex = useWorkspace(s => s.setSearchRegex)
  const replaceText = useWorkspace(s => s.searchReplace)
  const setReplaceText = useWorkspace(s => s.setSearchReplace)
  const replacing = useWorkspace(s => s.replacing)
  const replaceAll = useWorkspace(s => s.replaceAll)
  const undoId = useWorkspace(s => s.undoId)
  const undoing = useWorkspace(s => s.undoing)
  const undoReplace = useWorkspace(s => s.undoReplace)
  const hits = useWorkspace(s => s.searchHits)
  const busy = useWorkspace(s => s.searchBusy)
  const took = useWorkspace(s => s.searchTook)
  const error = useWorkspace(s => s.searchError)
  const status = useWorkspace(s => s.indexStatus)
  const indexing = useWorkspace(s => s.indexing)
  const root = useWorkspace(s => s.root)
  const toggleSearch = useWorkspace(s => s.toggleSearch)
  const openHit = useWorkspace(s => s.openHit)
  const rebuild = useWorkspace(s => s.rebuildIndex)
  const inputRef = useRef<HTMLInputElement>(null)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Esc 关抽屉；Ctrl+Shift+F 再按一次也关
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (e.key === 'Escape' || (mod && e.shiftKey && e.key.toLowerCase() === 'f')) {
        e.preventDefault()
        e.stopPropagation()
        toggleSearch()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [toggleSearch])

  const total = hits.reduce((n, h) => n + h.matches, 0)
  const groups = useMemo(() => groupHits(hits, root), [hits, root])
  const toggleGroup = (dir: string) => setCollapsed(c => ({ ...c, [dir]: !c[dir] }))

  return (
    <aside className="search-panel">
      <header className="search-head">
        <span className="search-title">全文搜索{regex ? '（正则）' : ''}</span>
        <button className="icon-btn" onClick={toggleSearch} title="关闭 (Esc)">
          ×
        </button>
      </header>

      <div className="search-bar">
        <div className="search-line">
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            placeholder={regex ? '正则，例如 TODO|FIXME' : '搜索全部笔记…'}
            onChange={e => setQuery(e.target.value)}
          />
          <button
            className={`search-flag${caseSensitive ? ' on' : ''}`}
            title="区分大小写"
            onClick={() => setCase(!caseSensitive)}
          >
            Aa
          </button>
          <button
            className={`search-flag${regex ? ' on' : ''}`}
            title="正则表达式：.* ^ $ [] () 都可用"
            onClick={() => setRegex(!regex)}
          >
            .*
          </button>
          <button
            className={`search-flag${replaceOpen ? ' on' : ''}`}
            title="替换（全部文件）"
            onClick={() => setReplaceOpen(o => !o)}
          >
            ⇄
          </button>
        </div>

        {replaceOpen && (
          <div className="search-line">
            <input
              className="search-input"
              value={replaceText}
              placeholder={regex ? '替换为…（$1 引用分组）' : '替换为…'}
              onChange={e => setReplaceText(e.target.value)}
            />
            <button
              className="btn"
              disabled={replacing || !query.trim()}
              title={regex ? '正则替换，$1 会展开成分组' : '按字面文本替换'}
              onClick={() => void replaceAll()}
            >
              {replacing ? '替换中…' : '全部替换'}
            </button>
            {undoId && (
              <button
                className="btn"
                disabled={undoing || replacing}
                title="把上一次全库替换改回去（替换后又动过的文件会跳过）"
                onClick={() => void undoReplace()}
              >
                {undoing ? '撤销中…' : '撤销'}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="search-info">
        {busy ? (
          <span>搜索中…</span>
        ) : query.trim() ? (
          <span>
            命中 {hits.length} 个文件 · {total} 处 · {groups.length} 个目录 · {took} ms
          </span>
        ) : (
          <span>输入关键词，中文按字匹配，英文按前缀</span>
        )}
        <button className="link-btn" disabled={indexing || !root} onClick={() => void rebuild()}>
          {indexing ? '建立中…' : '重建索引'}
        </button>
      </div>

      {error && <div className="search-error">{error}</div>}

      <div className="search-list">
        {!query.trim() && (
          <div className="search-empty">
            <div>搜正文，不只是文件名。</div>
            <div className="search-tip">
              中文按字切分：「笔记」也能命中「笔记本」；
              <br />
              英文按前缀：「note」能命中 notebook；
              <br />
              点 <b>.*</b> 切到正则：<code>TODO|FIXME</code>、<code>^#\s+\w+</code>。
            </div>
          </div>
        )}

        {query.trim() && !busy && !hits.length && !error && (
          <div className="search-empty">没有找到「{query.trim()}」</div>
        )}

        {groups.map(group => {
          const isCollapsed = !!collapsed[group.dir]
          return (
            <div className="search-group" key={group.dir}>
              <button
                className="search-group-head"
                title={group.dir}
                onClick={() => toggleGroup(group.dir)}
              >
                <span className="search-group-caret">{isCollapsed ? '▸' : '▾'}</span>
                <span className="search-group-name">{group.label}</span>
                <span className="search-group-meta">
                  {group.hits.length} 个文件 · {group.matches} 处
                </span>
              </button>

              {!isCollapsed &&
                group.hits.map(hit => (
                  <button
                    key={hit.path}
                    className="search-hit"
                    title={hit.path}
                    onClick={() => void openHit(hit)}
                  >
                    <span className="search-hit-head">
                      <span className="search-hit-name">{hit.name}</span>
                    </span>
                    <span className="search-hit-snippet">
                      {hit.snippet.map((seg, i) =>
                        seg.hit ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>
                      )}
                    </span>
                    <span className="search-hit-meta">
                      第 {hit.line} 行 · {hit.matches ? `${hit.matches} 处` : '路径命中'}
                    </span>
                  </button>
                ))}
            </div>
          )
        })}
      </div>

      <footer className="search-foot">
        {status ? `索引 ${status.files} 个文件 · ${stamp(status.builtAt)}` : '索引状态未知'}
        {root ? '' : ' · 先打开一个文件夹'}
        {regex ? ' · 正则模式扫索引正文，不走分词' : ''}
      </footer>
    </aside>
  )
}
