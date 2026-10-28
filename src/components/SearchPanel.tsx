import { useEffect, useRef } from 'react'
import { useWorkspace } from '../store/workspace'

function stamp(secs: number): string {
  if (!secs) return '还没建过索引'
  const d = new Date(secs * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function dirOf(path: string, name: string): string {
  const dir = path.slice(0, Math.max(0, path.length - name.length))
  return dir.replace(/[\\/]+$/, '')
}

/** 全文搜索结果抽屉（Ctrl+Shift+F） */
export function SearchPanel() {
  const query = useWorkspace(s => s.searchQuery)
  const setQuery = useWorkspace(s => s.setSearchQuery)
  const caseSensitive = useWorkspace(s => s.searchCase)
  const setCase = useWorkspace(s => s.setSearchCase)
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

  return (
    <aside className="search-panel">
      <header className="search-head">
        <span className="search-title">全文搜索</span>
        <button className="icon-btn" onClick={toggleSearch} title="关闭 (Esc)">
          ×
        </button>
      </header>

      <div className="search-bar">
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          placeholder="搜索全部笔记…"
          onChange={e => setQuery(e.target.value)}
        />
        <label className="search-opt" title="区分大小写">
          <input type="checkbox" checked={caseSensitive} onChange={e => setCase(e.target.checked)} />
          Aa
        </label>
      </div>

      <div className="search-info">
        {busy ? (
          <span>搜索中…</span>
        ) : query.trim() ? (
          <span>
            命中 {hits.length} 个文件 · {total} 处 · {took} ms
          </span>
        ) : (
          <span>输入关键词，中文按字匹配，英文按前缀</span>
        )}
        <button className="link-btn" disabled={indexing || !root} onClick={() => void rebuild()}>
          {indexing ? '建立中…' : '重建索引'}
        </button>
      </div>

      {error && <div className="search-error">{error}</div>}
      {error && <div className="search-empty">桌面端才能用 FTS5 索引；浏览器演示模式会在内存里扫演示文件。</div>}

      <div className="search-list">
        {!query.trim() && (
          <div className="search-empty">
            <div>搜正文，不只是文件名。</div>
            <div className="search-tip">
              中文按字切分：「笔记」也能命中「笔记本」；
              <br />
              英文按前缀：「note」能命中 notebook。
            </div>
          </div>
        )}

        {query.trim() && !busy && !hits.length && !error && (
          <div className="search-empty">没有找到「{query.trim()}」</div>
        )}

        {hits.map(hit => (
          <button
            key={hit.path}
            className="search-hit"
            title={hit.path}
            onClick={() => void openHit(hit)}
          >
            <span className="search-hit-head">
              <span className="search-hit-name">{hit.name}</span>
              <span className="search-hit-dir">{dirOf(hit.path, hit.name)}</span>
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

      <footer className="search-foot">
        {status ? `索引 ${status.files} 个文件 · ${stamp(status.builtAt)}` : '索引状态未知'}
        {root ? '' : ' · 先打开一个文件夹'}
      </footer>
    </aside>
  )
}
