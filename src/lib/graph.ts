/**
 * 链接图与标签索引。
 *
 * 数据来源分两种：
 * - 桌面端：`graph_scan` 直接读全文索引里的正文（不碰磁盘，几百篇也是毫秒级）
 * - 浏览器演示：没有索引，走内存示例工作区自己扫一遍，语义对齐
 *
 * 当前正在编辑的那篇，链接和标签用**缓冲区内容**覆盖——
 * 否则刚打的 `[[新笔记]]` 要等自动保存 + 重灌索引才会出现在面板里。
 */
import * as api from './api'
import { parseLinks, resolveLink, toGraphLinks, type GraphLink, type LinkKind } from './links'
import { parseTags, splitFrontMatter } from './tags'

export interface GNode {
  path: string
  name: string
  /** front-matter title → 首个标题 → 文件名 */
  title: string
  tags: string[]
  links: GraphLink[]
}

export interface Graph {
  root: string
  nodes: GNode[]
  /** 扫描耗时（毫秒） */
  took: number
}

/** 从正文推标题：先看 front-matter 的 title，再看第一个标题 */
export function titleOf(content: string, name: string): string {
  const split = splitFrontMatter(content)
  if (split.body) {
    const m = /^\s*title\s*:\s*(.+)$/m.exec(split.body)
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, '')
      if (v) return v
    }
  }
  const heading = /^#{1,6}[ \t]+(.+)$/m.exec(content)
  if (heading) return heading[1].trim()
  return name.replace(/\.md$/i, '')
}

/** 把一篇正文变成图里的节点（面板与演示模式共用） */
export function nodeOf(path: string, content: string): GNode {
  const name = path.split(/[\\/]/).pop() ?? path
  return {
    path,
    name,
    title: titleOf(content, name),
    tags: parseTags(content),
    links: toGraphLinks(parseLinks(content))
  }
}

export async function scan(root: string): Promise<Graph> {
  const t0 = Date.now()
  if (api.isTauri) {
    const raw = await api.graphScan(root)
    return { root, nodes: raw.nodes, took: raw.took ?? Date.now() - t0 }
  }
  return { root, nodes: await demoScan(root), took: Date.now() - t0 }
}

async function demoScan(root: string): Promise<GNode[]> {
  const paths: string[] = []
  const walk = (nodes: api.TreeNode[]) => {
    for (const n of nodes) {
      if (n.isDir) walk(n.children ?? [])
      else paths.push(n.path)
    }
  }
  walk(await api.readTree(root))

  const out: GNode[] = []
  for (const p of paths) {
    try {
      const f = await api.readFile(p)
      if (!f.binary) out.push(nodeOf(p, f.content))
    } catch {
      /* 读不了就不进图 */
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 反向链接                                                             */
/* ------------------------------------------------------------------ */

export interface Backref {
  /** 谁引用了我 */
  from: string
  fromName: string
  fromTitle: string
  /** 引用写在第几行 */
  line: number
  /** 链接的原始目标写法，用来判断是不是「未解析」 */
  target: string
}

/** 当前文档的出链、反链、被引用次数 */
export interface Around {
  outgoing: GraphLink[]
  incoming: Backref[]
}

/** 拿一张图算某篇笔记的反向链接；active 是当前缓冲区的覆盖版本 */
export function around(graph: Graph | null, active: GNode | null): Around {
  if (!active) return { outgoing: [], incoming: [] }
  const all = graph?.nodes ?? []
  const nodes = all.filter(n => n.path !== active.path)
  // 候选清单要含自己：别人写 [[我]] 得能解析到我这个路径上
  const notes = all.map(n => ({ path: n.path, title: n.title }))
  if (!notes.some(n => n.path === active.path)) notes.push({ path: active.path, title: active.title })
  const incoming: Backref[] = []

  for (const node of nodes) {
    for (const link of node.links) {
      const hit = resolveLink(link.target, link.kind, node.path, notes)
      if (hit !== active.path) continue
      incoming.push({
        from: node.path,
        fromName: node.name,
        fromTitle: node.title,
        line: link.line,
        target: link.target
      })
    }
  }
  return { outgoing: active.links, incoming }
}

/* ------------------------------------------------------------------ */
/* 断链体检                                                             */
/* ------------------------------------------------------------------ */

export interface BrokenLink {
  /** 写这条链接的文件 */
  path: string
  name: string
  title: string
  line: number
  target: string
  kind: LinkKind
}

/**
 * 全库指不到任何文件的链接。
 *
 * 改名 / 删文件 / 手误都会留下这种链接，双链用得越久越多，
 * 所以给一个「一次看全部」的清单，点一下跳到出处去修。
 */
export function brokenLinks(graph: Graph | null, active?: GNode | null): BrokenLink[] {
  const all = [...(graph?.nodes ?? [])]
  if (active) {
    const i = all.findIndex(n => n.path === active.path)
    if (i >= 0) all[i] = active
    else all.push(active)
  }

  const notes = all.map(n => ({ path: n.path, title: n.title }))
  const out: BrokenLink[] = []
  for (const node of all) {
    for (const link of node.links) {
      if (resolveLink(link.target, link.kind, node.path, notes)) continue
      out.push({
        path: node.path,
        name: node.name,
        title: node.title,
        line: link.line,
        target: link.target,
        kind: link.kind
      })
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return out
}

/* ------------------------------------------------------------------ */
/* 标签索引                                                             */
/* ------------------------------------------------------------------ */
export interface TagCount {
  tag: string
  count: number
  /** 带这个标签的文件路径 */
  paths: string[]
}

/** 全库标签 → 文件列表，按出现次数降序 */
export function tagIndex(graph: Graph | null, active: GNode | null): TagCount[] {
  const map = new Map<string, { tag: string; paths: string[] }>()
  const all = [...(graph?.nodes ?? [])]
  if (active) {
    const i = all.findIndex(n => n.path === active.path)
    if (i >= 0) all[i] = active
    else all.push(active)
  }
  for (const node of all) {
    for (const tag of node.tags) {
      const key = tag.toLowerCase()
      const hit = map.get(key)
      if (hit) {
        if (!hit.paths.includes(node.path)) hit.paths.push(node.path)
      } else {
        map.set(key, { tag, paths: [node.path] })
      }
    }
  }
  return Array.from(map.values())
    .map(v => ({ tag: v.tag, count: v.paths.length, paths: v.paths }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}
