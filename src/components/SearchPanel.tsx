import { useEffect, useMemo, useRef, useState } from 'react'
import { groupHits } from '../lib/dirgroup'
import { foldSpans } from '../lib/search'
import { navKey, navLabel, navPositions, stepIndex } from '../lib/searchnav'
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
  const panelRef = useRef<HTMLElement>(null)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  /** 键盘选中的位置下标；-1 = 还没选 */
  const [sel, setSel] = useState(-1)

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

  /** 摊平后的位置列表，顺序与渲染一致 */
  const positions = useMemo(() => navPositions(hits), [hits])
  const indexByKey = useMemo(() => {
    const m = new Map<string, number>()
    positions.forEach((p, i) => m.set(p.key, i))
    return m
  }, [positions])

  // 换了一次搜索就从头开始，别让旧下标指到新结果里的另一处
  useEffect(() => {
    setSel(-1)
  }, [hits])

  // 选中项滚进视野；jsdom 没有 scrollIntoView，忽略即可
  useEffect(() => {
    if (sel < 0) return
    const el = panelRef.current?.querySelector(`[data-nav="${sel}"]`) as HTMLElement | null
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [sel])

  /**
   * ↑↓ 在命中位置之间走，Enter 跳过去，Home/End 到首尾。
   *
   * 只在搜索抽屉里有反应：焦点在编辑器里时按方向键不该动这里。
   * 输入框里也接管 ↑↓（搜索框的方向键本来也没别的用处），
   * 但 Home/End 留给光标——正在改关键词时按 End 得跳到行尾。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as Node | null
      const inside =
        !target ||
        target === document.body ||
        target === (window as unknown as Node) ||
        !!panelRef.current?.contains(target)
      if (!inside) return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!positions.length) return
        e.preventDefault()
        e.stopPropagation()
        setSel(s => stepIndex(s, e.key === 'ArrowDown' ? 1 : -1, positions.length))
        return
      }
      if (e.key === 'Enter' && sel >= 0) {
        const pos = positions[sel]
        if (!pos) return
        e.preventDefault()
        e.stopPropagation()
        void openHit(pos)
        return
      }
      if ((e.key === 'Home' || e.key === 'End') && positions.length) {
        const tag = (target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        e.stopPropagation()
        setSel(e.key === 'Home' ? 0 : positions.length - 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [positions, sel, openHit])

  return (
    <aside className="search-panel" ref={panelRef}>
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
                group.hits.map(hit => {
                  // 有逐行上下文时，键盘位置落在每一行上；否则整个文件就是一处
                  const fileNav = hit.spans.length ? undefined : indexByKey.get(navKey(hit.path, hit.line))
                  return (
                  <div className="search-hit-wrap" key={hit.path}>
                    <button
                      className={`search-hit${fileNav !== undefined && sel === fileNav ? ' sel' : ''}`}
                      data-nav={fileNav}
                      title={hit.path}
                      onClick={() => void openHit(hit)}
                    >
                      <span className="search-hit-head">
                        <span className="search-hit-name">{hit.name}</span>
                      </span>
                      {/* 有逐行上下文时，文件行就不再挤一段摘要，省得同一处看两遍 */}
                      {!hit.spans.length && (
                        <span className="search-hit-snippet">
                          {hit.snippet.map((seg, i) =>
                            seg.hit ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>
                          )}
                        </span>
                      )}
                      <span className="search-hit-meta">
                        {hit.spans.length
                          ? `${hit.spanTotal} 行命中 · ${hit.matches || hit.spanTotal} 处`
                          : `第 ${hit.line} 行 · ${hit.matches ? `${hit.matches} 处` : '路径命中'}`}
                      </span>
                    </button>

                    {hit.spans.length > 0 && (
                      <div className="search-spans">
                        {foldSpans(hit.spans).map(block => (
                          <div className="search-block" key={block.from}>
                            {/* 两段之间断开了：告诉人跳了多少行，别以为漏了 */}
                            {block.gap > 0 && (
                              <div className="search-block-gap">⋯ 跳 {block.gap} 行</div>
                            )}
                            {block.spans.length > 1 && (
                              <div className="search-block-head">
                                第 {block.from}–{block.to} 行 · {block.hits} 处命中
                              </div>
                            )}
                            {block.spans.map(span => {
                              const nav = span.hit ? indexByKey.get(navKey(hit.path, span.line)) : undefined
                              return (
                              <button
                                key={span.line}
                                // 中间补的上下文行没高亮，样式压暗，跟命中行区分开
                                className={`search-span${span.hit ? '' : ' context'}${nav !== undefined && sel === nav ? ' sel' : ''}`}
                                data-nav={nav}
                                title={`跳到第 ${span.line} 行`}
                                onClick={() =>
                                  void openHit({ path: hit.path, line: span.line, column: span.column })
                                }
                              >
                                <span className="search-span-no">{span.line}</span>
                                <span className="search-span-text">
                                  {span.snippet.map((seg, i) =>
                                    seg.hit ? (
                                      <mark key={i}>{seg.text}</mark>
                                    ) : (
                                      <span key={i}>{seg.text}</span>
                                    )
                                  )}
                                </span>
                              </button>
                              )
                            })}
                          </div>
                        ))}
                        {hit.spanTotal > hit.spans.filter(s => s.hit).length && (
                          <div className="search-span-more">
                            还有 {hit.spanTotal - hit.spans.filter(s => s.hit).length} 行没列出，点文件名看全部
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  )
                })}
            </div>
          )
        })}
      </div>

      <footer className="search-foot">
        {positions.length > 0 && (
          <span className="search-nav-tip" title={sel >= 0 ? positions[sel]?.path : '↑↓ 在命中行之间移动'}>
            {sel >= 0 && positions[sel]
              ? navLabel(positions[sel], sel, positions.length)
              : '↑↓ 选位置 · Enter 跳过去'}
          </span>
        )}
        <span className="search-foot-meta">
          {status ? `索引 ${status.files} 个文件 · ${stamp(status.builtAt)}` : '索引状态未知'}
          {root ? '' : ' · 先打开一个文件夹'}
          {regex ? ' · 正则模式扫索引正文，不走分词' : ''}
        </span>
      </footer>
    </aside>
  )
}
