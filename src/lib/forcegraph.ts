/**
 * 知识图谱：把「笔记 + 链接」摊成一张可画的图。
 *
 * 分两步，都是纯函数（不碰 DOM、不看时间），所以能在 jsdom / node 里跑测试：
 * 1. `buildGraph` 解析每条链接落到哪个文件，同一条边只留一根、出现几次记成 weight；
 *    解析不到的链接可以变成「幽灵节点」（虚线），一眼看出哪些笔记还没写。
 * 2. `layoutGraph` 用固定随机种子的力导向布局，同样的输入永远得到同样的坐标，
 *    测试才好断言，用户重新打开图也不会「跳一下」。
 */
import { resolveLink, type GraphLink, type LinkKind } from './links'
import type { GNode, Graph } from './graph'
import { relativeDir } from './dirgroup'
import { baseName } from './path'

/** 幽灵节点的 id 前缀：这条链接指向的文件还不存在 */
export const GHOST = 'xnp-ghost:'
/** 一篇标签都没写的笔记落在这一簇 */
export const UNTAGGED = '未分类'
/** 断链（还没建的笔记）单独一簇，免得跟真笔记混在一起 */
export const UNCREATED = '未创建'

export interface VNode {
  /** 文件路径；幽灵节点是 `xnp-ghost:目标` */
  id: string
  path: string | null
  name: string
  title: string
  tags: string[]
  ghost: boolean
  /** 入度 + 出度，决定圆点大小 */
  degree: number
  /** 相对工作区的目录，只用来配色，同一个目录同一个颜色 */
  dir: string
  /** 幽灵节点的原始目标写法，点它去新建 */
  target: string
}

export interface VEdge {
  source: string
  target: string
  /** 同一对文件之间多种写法时，取第一次出现的类型和行号 */
  kind: LinkKind
  line: number
  /** 这对文件之间一共引用了几次 */
  weight: number
  /** 指向幽灵节点 */
  broken: boolean
}

export interface GraphStats {
  notes: number
  /** 索引里有、但不是笔记（.py/.csv 之类）而没收进图的文件 */
  skipped: number
  ghosts: number
  edges: number
  /** 没有任何链接进出的笔记 */
  isolated: number
  /** 断链条数（按出现次数算，不是按边算） */
  broken: number
  /** 指向自己的链接，画出来是个圈，直接跳过 */
  selfLinks: number
}

export interface BuiltGraph {
  nodes: VNode[]
  edges: VEdge[]
  stats: GraphStats
}

export interface BuildOptions {
  /** 断链画成幽灵节点，默认开 */
  ghosts?: boolean
}

/**
 * 只留「笔记」：Markdown 文件，或者虽然扩展名不是 md、但正文里写了链接 / 标签的文本。
 *
 * 全文索引里连着 .py、.csv 一起收了，全画出来就是一堆没连线的孤点，
 * 把真正该看的笔记挤成一小撮。
 */
function isNote(n: GNode): boolean {
  return /\.(md|markdown|mdx)$/i.test(n.path) || n.links.length > 0 || n.tags.length > 0
}

/** 把 active 的缓冲区内容覆盖到图里（正在编辑的这篇不该等自动保存） */
function mergeActive(graph: Graph | null, active: GNode | null): GNode[] {
  const all = [...(graph?.nodes ?? [])]
  if (!active) return all
  const i = all.findIndex(n => n.path === active.path)
  if (i >= 0) all[i] = active
  else all.push(active)
  return all
}

export function buildGraph(
  graph: Graph | null,
  active: GNode | null,
  opts: BuildOptions = {}
): BuiltGraph {
  const withGhosts = opts.ghosts !== false
  const merged = mergeActive(graph, active)
  const raw = merged.filter(isNote)
  const skipped = merged.length - raw.length
  const root = graph?.root ?? null
  const notes = raw.map(n => ({ path: n.path, title: n.title }))

  const nodes = new Map<string, VNode>()
  for (const n of raw) {
    nodes.set(n.path, {
      id: n.path,
      path: n.path,
      name: n.name,
      title: n.title,
      tags: n.tags,
      ghost: false,
      degree: 0,
      dir: relativeDir(n.path, n.name, root).label,
      target: ''
    })
  }

  const edges = new Map<string, VEdge>()
  let selfLinks = 0
  let broken = 0

  for (const n of raw) {
    for (const link of n.links as GraphLink[]) {
      const hit = resolveLink(link.target, link.kind, n.path, notes)
      let to: string
      if (hit) {
        to = hit
      } else {
        broken++
        if (!withGhosts) continue
        to = GHOST + link.target.toLowerCase()
        if (!nodes.has(to)) {
          const name = baseName(link.target.replace(/\\/g, '/')) || link.target
          nodes.set(to, {
            id: to,
            path: null,
            name,
            title: name,
            tags: [],
            ghost: true,
            degree: 0,
            dir: '未创建',
            target: link.target
          })
        }
      }
      if (to === n.path) {
        selfLinks++
        continue
      }
      const key = `${n.path}\u0000${to}`
      const hitEdge = edges.get(key)
      if (hitEdge) hitEdge.weight++
      else
        edges.set(key, {
          source: n.path,
          target: to,
          kind: link.kind,
          line: link.line,
          weight: 1,
          broken: !hit
        })
    }
  }

  const list = Array.from(nodes.values())
  for (const e of edges.values()) {
    const a = nodes.get(e.source)
    const b = nodes.get(e.target)
    if (a) a.degree++
    if (b) b.degree++
  }
  list.sort((a, b) => a.id.localeCompare(b.id))

  const stats: GraphStats = {
    notes: raw.length,
    /** 索引里有、但不是笔记（.py/.csv 之类）而没收进图的文件 */
    skipped,
    ghosts: list.filter(n => n.ghost).length,
    edges: edges.size,
    isolated: list.filter(n => !n.ghost && n.degree === 0).length,
    broken,
    selfLinks
  }
  return { nodes: list, edges: Array.from(edges.values()), stats }
}

/* ------------------------------------------------------------------ */
/* 力导向布局                                                           */
/* ------------------------------------------------------------------ */

export interface Point {
  x: number
  y: number
}

export interface LayoutOptions {
  width?: number
  height?: number
  /** 迭代次数越多越散得开，但 200 次之后基本看不出差别 */
  iterations?: number
  seed?: number
  /** 按标签聚簇：同主标签的笔记向自己的簇心收拢 */
  cluster?: boolean
}

/* ------------------------------------------------------------------ */
/* 聚类                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 一个节点归哪一簇：取**主标签**（front-matter 里写的第一个），
 * 没写标签的归「未分类」，断链归「未创建」。
 *
 * 一篇笔记只能在一簇里，所以不按「它有哪几个标签」做多重归属——
 * 那样同一个点要画好几遍，边也跟着重复。想换簇就调 front-matter 里标签的顺序。
 */
export function clusterOf(node: VNode): string {
  if (node.ghost) return UNCREATED
  return node.tags[0] ?? UNTAGGED
}

export interface ClusterGroup {
  key: string
  ids: string[]
}

/** 分簇：簇按大小降序，同样大按名字排，保证同一份数据永远同一个顺序 */
export function clusterGroups(nodes: VNode[]): ClusterGroup[] {
  const map = new Map<string, string[]>()
  for (const n of nodes) {
    const key = clusterOf(n)
    const hit = map.get(key)
    if (hit) hit.push(n.id)
    else map.set(key, [n.id])
  }
  return Array.from(map, ([key, ids]) => ({ key, ids })).sort(
    (a, b) => b.ids.length - a.ids.length || a.key.localeCompare(b.key)
  )
}

/** 布好局之后每一簇的位置：质心 + 最远半径（画淡圈、贴标签用） */
export interface ClusterPatch extends ClusterGroup {
  x: number
  y: number
  radius: number
}

export function clustersOf(nodes: VNode[], pos: Record<string, Point>): ClusterPatch[] {
  const out: ClusterPatch[] = []
  for (const group of clusterGroups(nodes)) {
    let sx = 0
    let sy = 0
    let n = 0
    for (const id of group.ids) {
      const p = pos[id]
      if (!p) continue
      sx += p.x
      sy += p.y
      n++
    }
    if (!n) continue
    const x = sx / n
    const y = sy / n
    let radius = 0
    for (const id of group.ids) {
      const p = pos[id]
      if (p) radius = Math.max(radius, Math.hypot(p.x - x, p.y - y))
    }
    out.push({ ...group, x, y, radius })
  }
  return out
}

export interface Layout {
  /** id → 坐标，坐标已经缩放进 width × height，直接画 */
  pos: Record<string, Point>
  width: number
  height: number
}

/** 确定性伪随机：同一个种子永远同一串数（Math.random 会让布局每次都不一样） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 簇引力相对全局向心力的倍数：调到 1 附近簇会散开，太大又挤成一坨 */
const CLUSTER_PULL = 3.2

export function layoutGraph(
  nodes: VNode[],
  edges: VEdge[],
  opts: LayoutOptions = {}
): Layout {
  const width = opts.width ?? 1200
  const height = opts.height ?? 800
  const n = nodes.length
  if (!n) return { pos: {}, width, height }

  const rng = mulberry32(opts.seed ?? 20261028)
  const iterations = Math.max(1, opts.iterations ?? (n > 300 ? 110 : 200))
  const index = new Map<string, number>()
  nodes.forEach((node, i) => index.set(node.id, i))

  // 初始摆位：黄金角螺旋，避免所有点从同一个地方出发（那样斥力方向会退化）
  const R = Math.min(width, height) * 0.42
  const golden = Math.PI * (3 - Math.sqrt(5))
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)

  // 聚簇：簇心摆在一个圆上，簇内再铺一层小螺旋。初始位置就分了组，
  // 力导向只是把每组收得更紧，不会出现「同标签的两点从对角出发、最后各奔东西」
  const clusterOn = !!opts.cluster
  const clusterIdx = new Int32Array(n).fill(-1)
  let centers: Array<[number, number]> = []
  if (clusterOn) {
    const groups = clusterGroups(nodes)
    const m = groups.length
    const Rc = Math.min(width, height) * 0.3
    const slot = new Map<string, number>()
    groups.forEach((g, gi) => slot.set(g.key, gi))
    centers =
      m === 1
        ? [[0, 0]]
        : groups.map((_, gi) => {
            const a = (gi / m) * Math.PI * 2 - Math.PI / 2
            return [Math.cos(a) * Rc, Math.sin(a) * Rc] as [number, number]
          })
    const filled = new Map<string, number>()
    for (let i = 0; i < n; i++) {
      const key = clusterOf(nodes[i])
      const gi = slot.get(key) ?? 0
      clusterIdx[i] = gi
      const j = filled.get(key) ?? 0
      filled.set(key, j + 1)
      const size = Math.max(groups[gi]?.ids.length ?? 1, 1)
      const spread = Rc * 0.55 * Math.sqrt((j + 0.5) / size)
      const a = j * golden + rng() * 0.3
      xs[i] = (centers[gi]?.[0] ?? 0) + Math.cos(a) * spread
      ys[i] = (centers[gi]?.[1] ?? 0) + Math.sin(a) * spread
    }
  } else {
    for (let i = 0; i < n; i++) {
      const r = R * Math.sqrt((i + 0.5) / n)
      const a = i * golden + rng() * 0.4
      xs[i] = Math.cos(a) * r
      ys[i] = Math.sin(a) * r
    }
  }

  // 理想边长：面积均摊到每个点，再乘个系数（太小会挤成一团，太大跑出画布）
  const k = Math.sqrt((width * height) / n) * 0.55
  const pairs: Array<[number, number]> = []
  for (const e of edges) {
    const a = index.get(e.source)
    const b = index.get(e.target)
    if (a === undefined || b === undefined || a === b) continue
    pairs.push([a, b])
  }

  const maxStep = k * 0.9
  for (let iter = 0; iter < iterations; iter++) {
    dx.fill(0)
    dy.fill(0)

    // 斥力：每个点都被别的点推开，f = k²/d
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let vx = xs[i] - xs[j]
        let vy = ys[i] - ys[j]
        let d2 = vx * vx + vy * vy
        if (d2 < 0.01) {
          // 完全重合：给一个确定性的小扰动，别用随机数（会破坏可重复性）
          vx = (i % 7) - 3 + 0.5
          vy = (j % 5) - 2 + 0.5
          d2 = vx * vx + vy * vy
        }
        const d = Math.sqrt(d2)
        const f = (k * k) / d
        const ux = (vx / d) * f
        const uy = (vy / d) * f
        dx[i] += ux
        dy[i] += uy
        dx[j] -= ux
        dy[j] -= uy
      }
    }

    // 引力：有链接的两点互相拉，f = d²/k
    for (const [a, b] of pairs) {
      const vx = xs[a] - xs[b]
      const vy = ys[a] - ys[b]
      const d = Math.sqrt(vx * vx + vy * vy) || 0.01
      const f = (d * d) / k
      const ux = (vx / d) * f
      const uy = (vy / d) * f
      dx[a] -= ux
      dy[a] -= uy
      dx[b] += ux
      dy[b] += uy
    }

    // 簇引力：同主标签的点被拉向簇心。比全局向心力硬，才压得住点之间的斥力
    if (clusterOn) {
      const stiff = 0.02 * k * CLUSTER_PULL
      for (let i = 0; i < n; i++) {
        const c = centers[clusterIdx[i]]
        if (!c) continue
        dx[i] += (c[0] - xs[i]) * stiff
        dy[i] += (c[1] - ys[i]) * stiff
      }
    }

    // 向心力：只靠斥力的话整张图会慢慢炸开
    const temp = maxStep * (1 - iter / iterations)
    for (let i = 0; i < n; i++) {
      dx[i] -= xs[i] * 0.02 * k
      dy[i] -= ys[i] * 0.02 * k
      const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i])
      if (len < 1e-9) continue
      const step = Math.min(len, temp)
      xs[i] += (dx[i] / len) * step
      ys[i] += (dy[i] / len) * step
    }
  }

  // 缩放平移到画布内：留 8% 边距，圆心对齐
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xs[i])
    maxX = Math.max(maxX, xs[i])
    minY = Math.min(minY, ys[i])
    maxY = Math.max(maxY, ys[i])
  }
  const spanX = Math.max(maxX - minX, 1e-6)
  const spanY = Math.max(maxY - minY, 1e-6)
  const pad = 0.08
  const scale = Math.min((width * (1 - pad * 2)) / spanX, (height * (1 - pad * 2)) / spanY)
  // 单点或一条直线时 scale 会很大，用 1 兜底，点就落在正中
  const s = Number.isFinite(scale) && scale > 0 ? Math.min(scale, 6) : 1
  const offX = (width - spanX * s) / 2
  const offY = (height - spanY * s) / 2

  const pos: Record<string, Point> = {}
  for (let i = 0; i < n; i++) {
    pos[nodes[i].id] = {
      x: (xs[i] - minX) * s + offX,
      y: (ys[i] - minY) * s + offY
    }
  }
  return { pos, width, height }
}

/* ------------------------------------------------------------------ */
/* 查询小工具                                                           */
/* ------------------------------------------------------------------ */

/** 和某个节点直接相连的节点（含自己，方便高亮自身） */
export function neighborsOf(edges: VEdge[], id: string): Set<string> {
  const out = new Set<string>([id])
  for (const e of edges) {
    if (e.source === id) out.add(e.target)
    else if (e.target === id) out.add(e.source)
  }
  return out
}

/** 搜索：名字、标题、标签，忽略大小写；空串表示不筛 */
export function matchNodes(nodes: VNode[], query: string): Set<string> {
  const q = query.trim().toLowerCase()
  if (!q) return new Set()
  const out = new Set<string>()
  for (const n of nodes) {
    if (
      n.name.toLowerCase().includes(q) ||
      n.title.toLowerCase().includes(q) ||
      n.tags.some(t => t.toLowerCase().includes(q))
    )
      out.add(n.id)
  }
  return out
}

/** 目录 → 0..7 的配色下标，同一个目录永远同一个颜色 */
export function hueOf(dir: string): number {
  let h = 0
  for (let i = 0; i < dir.length; i++) h = (h * 31 + dir.charCodeAt(i)) | 0
  return Math.abs(h) % 8
}
