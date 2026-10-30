import { useEffect, useMemo, useRef, useState } from 'react'
import * as fg from '../lib/forcegraph'
import * as graphLib from '../lib/graph'
import { joinPath } from '../lib/path'
import { useWorkspace } from '../store/workspace'

/** 逻辑画布尺寸：布局在这个坐标系里算，视口只负责缩放平移 */
const W = 1200
const H = 800
const MIN_K = 0.25
const MAX_K = 3

const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k))

/** jsdom 里没有 setPointerCapture，别为它崩掉整个浮层 */
function capture(el: Element, pointerId: number) {
  const fn = (el as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture
  try {
    fn?.call(el, pointerId)
  } catch {
    /* 忽略 */
  }
}

/**
 * 知识图谱（Ctrl+Shift+G）。
 *
 * 全屏浮层而不是第四个侧栏页签：图要看全局，塞进 300px 的侧栏没意义。
 * 点圆点打开笔记并关掉浮层——图是用来找路的，不是用来看的。
 */
export function GraphView() {
  const graph = useWorkspace(s => s.graph)
  const graphBusy = useWorkspace(s => s.graphBusy)
  const root = useWorkspace(s => s.root)
  const activePath = useWorkspace(s => s.active)
  const activeContent = useWorkspace(s => (s.active ? s.docs[s.active]?.content ?? '' : ''))
  const toggleGraph = useWorkspace(s => s.toggleGraph)
  const openFile = useWorkspace(s => s.openFile)
  const openWiki = useWorkspace(s => s.openWiki)
  const refreshGraph = useWorkspace(s => s.refreshGraph)

  const [ghosts, setGhosts] = useState(true)
  /** 布局种子：点「重排」换一个，纠缠在一起的图可以抖开 */
  const [seed, setSeed] = useState(20261028)
  const [onlyIsolated, setOnlyIsolated] = useState(false)
  /** 按主标签聚簇：把同一类笔记收成一团 */
  const [cluster, setCluster] = useState(false)
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState('')
  const [hover, setHover] = useState<string | null>(null)
  const [offsets, setOffsets] = useState<Record<string, { x: number; y: number }>>({})
  const [box, setBox] = useState({ w: 1000, h: 700 })
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })

  const svgRef = useRef<SVGSVGElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const panRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const dragRef = useRef<{
    id: string
    sx: number
    sy: number
    ox: number
    oy: number
    moved: boolean
  } | null>(null)

  // 当前文档用缓冲区内容覆盖，正在打的 [[链接]] 立刻出现在图上；
  // 但只按「链接/标签有没有变」重算，否则每敲一个字布局都重排。
  const active = useMemo(
    () => (activePath ? graphLib.nodeOf(activePath, activeContent) : null),
    [activePath, activeContent]
  )
  const activeSig = active
    ? JSON.stringify([active.path, active.title, active.tags, active.links])
    : ''
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const built = useMemo(() => fg.buildGraph(graph, active, { ghosts }), [graph, activeSig, ghosts])
  const layout = useMemo(
    () => fg.layoutGraph(built.nodes, built.edges, { width: W, height: H, seed, cluster }),
    [built, seed, cluster]
  )

  const tags = useMemo(() => {
    const set = new Set<string>()
    for (const n of built.nodes) for (const t of n.tags) set.add(t)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [built.nodes])

  const clusters = useMemo(
    () => (cluster ? fg.clustersOf(built.nodes, layout.pos) : []),
    [cluster, built.nodes, layout.pos]
  )
  const matched = useMemo(() => fg.matchNodes(built.nodes, query), [built.nodes, query])
  const tagMatched = useMemo(() => {
    if (!tag) return null
    const want = tag.toLowerCase()
    return new Set(built.nodes.filter(n => n.tags.some(t => t.toLowerCase() === want)).map(n => n.id))
  }, [built.nodes, tag])

  const focus = useMemo(() => {
    if (hover) return fg.neighborsOf(built.edges, hover)
    if (activePath) return fg.neighborsOf(built.edges, activePath)
    return null
  }, [hover, activePath, built.edges])

  // 结构变了就丢掉手动拖出来的偏移，重新布局也重置
  useEffect(() => {
    setOffsets({})
  }, [layout])

  // 视口尺寸：浮层是全屏的，窗口拉大拉小要跟着重算
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    // 浏览器演示模式的 jsdom 没有 ResizeObserver，量一次就够了
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 自动铺满：比例取小的那一边，多出来的留白居中
  useEffect(() => {
    if (!box.w || !box.h) return
    const k = clampK(Math.min(box.w / W, box.h / H) * 0.94)
    setView({ k, x: (box.w - W * k) / 2, y: (box.h - H * k) / 2 })
  }, [layout, box.w, box.h])

  // 滚轮缩放要 preventDefault，React 的 onWheel 是 passive 的，只能自己挂
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      setView(v => {
        const k = clampK(v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12))
        // 以指针位置为中心缩放：保持指针下方的图上坐标不动
        const wx = (mx - v.x) / v.k
        const wy = (my - v.y) / v.k
        return { k, x: mx - wx * k, y: my - wy * k }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  // Esc 关掉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        toggleGraph()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [toggleGraph])

  const toGraph = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k }
  }

  const onBgDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    panRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    capture(e.currentTarget as Element, e.pointerId)
  }

  const onNodeDown = (e: React.PointerEvent, node: fg.VNode) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const p = offsets[node.id] ?? layout.pos[node.id]
    if (!p) return
    dragRef.current = { id: node.id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false }
    capture(e.currentTarget as Element, e.pointerId)
  }

  const onMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (drag) {
      const dx = (e.clientX - drag.sx) / view.k
      const dy = (e.clientY - drag.sy) / view.k
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
      setOffsets(o => ({ ...o, [drag.id]: { x: drag.ox + dx, y: drag.oy + dy } }))
      return
    }
    const pan = panRef.current
    if (pan) setView(v => ({ ...v, x: pan.vx + (e.clientX - pan.x), y: pan.vy + (e.clientY - pan.y) }))
  }

  const onUp = (e: React.PointerEvent) => {
    panRef.current = null
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || drag.moved) return
    const node = built.nodes.find(n => n.id === drag.id)
    if (!node) return
    if (node.ghost) {
      // 断链点一下就问「要不要建这篇」，跟双链面板的行为一致。
      // 没有打开任何文件时从工作区根目录算起（新建会落在根目录，不会落到工作区外面）。
      const from = activePath || (root ? joinPath(root, '_') : '')
      if (from) void openWiki(node.target, 'wiki', from)
      return
    }
    void openFile(node.id)
    toggleGraph()
  }

  const stats = built.stats
  const degreeOf = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of built.nodes) m.set(n.id, n.degree)
    return m
  }, [built.nodes])
  const dirs = useMemo(() => {
    const seen: string[] = []
    for (const n of built.nodes) if (!seen.includes(n.dir)) seen.push(n.dir)
    return seen.slice(0, 6)
  }, [built.nodes])

  const dim = (id: string) => {
    if (matched.size && !matched.has(id)) return true
    if (tagMatched && !tagMatched.has(id)) return true
    if (onlyIsolated) {
      const deg = degreeOf.get(id) ?? 0
      if (deg > 0) return true
    }
    return false
  }

  return (
    <div className="graph-overlay">
      <header className="graph-head">
        <div className="graph-title">
          知识图谱
          <span className="graph-sub">
            {graphBusy ? '扫描中…' : `${stats.notes} 篇 · ${stats.edges} 条链接 · ${stats.isolated} 篇孤立`}
            {stats.broken > 0 && <b className="graph-broken"> · {stats.broken} 处断链</b>}
          </span>
        </div>
        <div className="graph-tools">
          <input
            className="graph-input"
            value={query}
            placeholder="找笔记 / 标签…"
            onChange={e => setQuery(e.target.value)}
          />
          <select className="graph-select" value={tag} onChange={e => setTag(e.target.value)}>
            <option value="">全部标签</option>
            {tags.map(t => (
              <option key={t} value={t}>
                #{t}
              </option>
            ))}
          </select>
          <button
            className={`chip${ghosts ? ' on' : ''}`}
            onClick={() => setGhosts(v => !v)}
            title="把指向不存在文件的双链画成虚线空心点"
          >
            断链
          </button>
          <button
            className={`chip${onlyIsolated ? ' on' : ''}`}
            onClick={() => setOnlyIsolated(v => !v)}
            title="只留下没有任何链接进出的笔记"
          >
            孤立
          </button>
          <button
            className={`chip${cluster ? ' on' : ''}`}
            disabled={!tags.length}
            onClick={() => setCluster(v => !v)}
            title={
              tags.length
                ? '同一主标签的笔记收成一团（没写标签的归「未分类」，断链归「未创建」）'
                : '这些笔记还没有标签，先在 front-matter 里写 tags 再聚簇'
            }
          >
            标签簇
          </button>
          <button className="chip" onClick={() => setSeed(v => v + 1)} title="换一套初始摆位重新布局">
            重排
          </button>
          <button className="chip" onClick={() => void refreshGraph()} title="重新扫描全库链接">
            重扫
          </button>
          <button className="icon-btn" onClick={toggleGraph} title="关闭 (Esc)">
            ×
          </button>
        </div>
      </header>

      <div className="graph-canvas" ref={wrapRef}>
        <svg
          ref={svgRef}
          className="graph-svg"
          width="100%"
          height="100%"
          onPointerDown={onBgDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={() => setHover(null)}
        >
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {clusters.map(cl => {
              const r = Math.max(cl.radius + 12, 26)
              return (
                <g key={`cluster-${cl.key}`} className={`gcluster${cl.key === fg.UNCREATED ? ' ghost' : ''}`}>
                  {cl.ids.length >= 2 && <circle cx={cl.x} cy={cl.y} r={r} />}
                  <text x={cl.x} y={cl.y - r - 6}>
                    {cl.key} · {cl.ids.length}
                  </text>
                </g>
              )
            })}
            {built.edges.map(e => {
              const a = offsets[e.source] ?? layout.pos[e.source]
              const b = offsets[e.target] ?? layout.pos[e.target]
              if (!a || !b) return null
              const hot = !!focus && focus.has(e.source) && focus.has(e.target)
              const faded = dim(e.source) || dim(e.target)
              return (
                <line
                  key={`${e.source}->${e.target}`}
                  className={`gedge${e.broken ? ' broken' : ''}${hot ? ' hot' : ''}${faded ? ' dim' : ''}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  strokeWidth={e.weight > 1 ? 1 + Math.min(3, e.weight) : 1}
                />
              )
            })}
            {built.nodes.map(node => {
              const p = offsets[node.id] ?? layout.pos[node.id]
              if (!p) return null
              const faded = dim(node.id)
              const hot = focus?.has(node.id) ?? false
              const isActive = node.path !== null && node.path === activePath
              const r = node.ghost ? 4 : 5 + Math.min(9, Math.sqrt(node.degree) * 3)
              const showLabel = node.degree >= 2 || view.k > 1.4 || hot || matched.has(node.id)
              // 聚簇时颜色跟着簇走（图例也跟着换），否则同一簇的点颜色乱七八糟，白聚了
              const hue = fg.hueOf(cluster ? fg.clusterOf(node) : node.dir)
              return (
                <g
                  key={node.id}
                  className={`gnode h${hue}${node.ghost ? ' ghost' : ''}${
                    isActive ? ' active' : ''
                  }${faded ? ' dim' : ''}${hot ? ' hot' : ''}`}
                  transform={`translate(${p.x},${p.y})`}
                  onPointerDown={e => onNodeDown(e, node)}
                  onPointerEnter={() => setHover(node.id)}
                  onPointerLeave={() => setHover(h => (h === node.id ? null : h))}
                >
                  <circle r={r} />
                  {(showLabel || isActive) && (
                    <text className="glabel" x={r + 4} y={4}>
                      {node.title.length > 18 ? `${node.title.slice(0, 17)}…` : node.title}
                    </text>
                  )}
                  <title>{node.ghost ? `未创建：${node.target}` : `${node.title} — ${node.id}`}</title>
                </g>
              )
            })}
          </g>
        </svg>

        <div className="graph-legend">
          {cluster
            ? clusters.slice(0, 6).map(cl => (
                <span key={cl.key} className={`legend-item h${fg.hueOf(cl.key)}`}>
                  <i /> {cl.key}（{cl.ids.length}）
                </span>
              ))
            : dirs.map(d => (
                <span key={d} className={`legend-item h${fg.hueOf(d)}`}>
                  <i /> {d}
                </span>
              ))}
          {stats.ghosts > 0 && (
            <span className="legend-item ghost">
              <i /> 未创建（{stats.ghosts}）
            </span>
          )}
        </div>

        {built.nodes.length === 0 && (
          <div className="graph-empty">这个工作区还没有 Markdown 笔记。写一篇，再用 [[双链]] 连起来。</div>
        )}
        <div className="graph-hint">
          拖动空白处平移 · 滚轮缩放 · 拖动圆点摆位置 · 点圆点打开笔记
          {cluster ? ' · 同一主标签的笔记已成簇，改 front-matter 里标签的顺序就换簇' : ''}
        </div>
      </div>
    </div>
  )
}
