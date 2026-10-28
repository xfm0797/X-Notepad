/**
 * 双链：`[[笔记]]` / `[[笔记|别名]]`，以及指向本地 `.md` 的普通 Markdown 链接。
 *
 * 三条约定：
 * - 代码块和行内代码里的 `[[...]]` 不算链接（写笔记时经常要举例子）
 * - 目标按「文件名 → 标题 → 路径后缀」的顺序找，找不到就是未解析
 * - 所有位置都是**原文字符偏移**，所以预览替换、面板跳转都能共用一套解析
 */
import { baseName, parentOf } from './path'

export type LinkKind = 'wiki' | 'md'

export interface LinkRef {
  /** 目标，已去掉 `#anchor` 和 `.md` */
  target: string
  /** 显示文字：别名，没有就用目标 */
  label: string
  /** 原始写法，原样插回文档用 */
  raw: string
  kind: LinkKind
  /** 1 起算的行号 */
  line: number
  /** 字符偏移（0 起） */
  from: number
  to: number
}

/** 图里的一条链接：面板只需要这几项，不带偏移 */
export interface GraphLink {
  target: string
  label: string
  kind: LinkKind
  line: number
}

export interface NoteNode {
  path: string
  /** 用来做「按标题找」的第二匹配项 */
  title?: string
}

/* ------------------------------------------------------------------ */
/* 掩码：把代码位置换成空格，长度和行号都不变                            */
/* ------------------------------------------------------------------ */

/** 把围栏代码块和行内代码替换成等长空格，这样正则不会在代码里乱匹配 */
export function maskCode(text: string): string {
  let fence: string | null = null
  return text
    .split('\n')
    .map(line => {
      const open = /^\s*(`{3,}|~{3,})/.exec(line)
      if (fence) {
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null
        return ' '.repeat(line.length)
      }
      if (open) {
        fence = open[1]
        return ' '.repeat(line.length)
      }
      // 行内代码：`a` / ``a`b``
      return line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, s => ' '.repeat(s.length))
    })
    .join('\n')
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/** `notes/想法.md#标题` → `notes/想法` */
export function normalizeTarget(raw: string): string {
  let t = raw.trim()
  const hash = t.indexOf('#')
  if (hash >= 0) t = t.slice(0, hash)
  t = t.replace(/\\/g, '/').replace(/^\.\//, '')
  t = t.replace(/\.md$/i, '')
  return t.trim()
}

const WIKI = /\[\[([^[\]\n]+)\]\]/g
const MD = /(!?)\[([^\]\n]*)\]\(([^)\s]+?)\)/g
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** 扫出全文的链接，按出现顺序返回 */
export function parseLinks(text: string): LinkRef[] {
  const masked = maskCode(text)
  const starts = lineStarts(text)
  const out: LinkRef[] = []

  for (const m of masked.matchAll(WIKI)) {
    const at = m.index ?? 0
    const inner = text.slice(at + 2, at + m[0].length - 2)
    const bar = inner.indexOf('|')
    const target = normalizeTarget(bar >= 0 ? inner.slice(0, bar) : inner)
    if (!target) continue
    const alias = bar >= 0 ? inner.slice(bar + 1).trim() : ''
    out.push({
      target,
      label: alias || inner.split('|')[0].trim(),
      raw: m[0],
      kind: 'wiki',
      line: lineOf(starts, at),
      from: at,
      to: at + m[0].length
    })
  }

  for (const m of masked.matchAll(MD)) {
    if (m[1]) continue // 图片 `![alt](x.md)` 不算引用
    const href = m[3]
    if (EXTERNAL.test(href) || href.startsWith('#') || href.startsWith('/')) continue
    if (!/\.md(#.*)?$/i.test(href)) continue
    const at = m.index ?? 0
    const target = normalizeTarget(href)
    if (!target) continue
    out.push({
      target,
      label: m[2].trim() || target,
      raw: m[0],
      kind: 'md',
      line: lineOf(starts, at),
      from: at,
      to: at + m[0].length
    })
  }

  out.sort((a, b) => a.from - b.from)
  return out
}

/** 面板要的精简版 */
export function toGraphLinks(refs: LinkRef[]): GraphLink[] {
  return refs.map(r => ({ target: r.target, label: r.label, kind: r.kind, line: r.line }))
}

/* ------------------------------------------------------------------ */
/* 解析目标 → 文件                                                      */
/* ------------------------------------------------------------------ */

/** 文件名去掉 .md，双链就用这个名字指代一篇笔记 */
export function noteName(path: string): string {
  return baseName(path).replace(/\.md$/i, '')
}

function unify(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

/** 相对路径拼成绝对路径（统一用 /，仅供比较） */
function normJoin(dir: string, rel: string): string {
  const parts = `${unify(dir)}/${rel}`.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length > 1) out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

/**
 * 找到链接指向的文件。
 * 找不到返回 null —— 面板会把它当「未解析」，点一下可以新建。
 */
export function resolveLink(
  target: string,
  kind: LinkKind,
  fromPath: string,
  notes: NoteNode[]
): string | null {
  const want = normalizeTarget(target).toLowerCase()
  if (!want) return null

  if (kind === 'md') {
    // 相对路径优先：笔记里写 `[x](../notes/a.md)` 就该按相对位置找
    const abs = normJoin(parentOf(fromPath), want)
    const exact = notes.find(n => unify(n.path).replace(/\.md$/, '') === abs)
    if (exact) return exact.path
  }

  const byBase = notes.filter(n => noteName(n.path).toLowerCase() === want)
  if (byBase.length) return byBase[0].path

  // 标题匹配（front-matter title 或首个标题，由调用方填进 title）
  const byTitle = notes.filter(n => (n.title ?? '').toLowerCase() === want)
  if (byTitle.length) return byTitle[0].path

  // 带目录的写法：`[[notes/想法]]`
  const suffix = `/${want}`
  const byPath = notes.filter(n => {
    const p = unify(n.path).replace(/\.md$/, '')
    return p.endsWith(suffix) || p.endsWith(`${suffix}.md`)
  })
  return byPath.length ? byPath[0].path : null
}

/** 生成双链文本 */
export function wikiText(target: string, label?: string): string {
  const t = noteName(target)
  return label && label !== t ? `[[${t}|${label}]]` : `[[${t}]]`
}

/* ------------------------------------------------------------------ */
/* 预览：把链接换成可点的锚点                                            */
/* ------------------------------------------------------------------ */

/**
 * 预览里用 `#xnp-wiki:` 前缀的锚点表示「打开某篇笔记」。
 *
 * 为什么不直接写 `<a data-wiki>`：comrak 默认转义原始 HTML（这是对的，
 * 笔记里的 HTML 不该随便执行）。用普通的 Markdown 链接语法，
 * 渲染器不用改，点击时从 href 里把目标解出来就行。
 */
export const WIKI_SCHEME = '#xnp-wiki:'

/** 解出锚点里的目标，不是双链就返回 null */
export function parseWikiHref(href: string): { target: string; kind: LinkKind } | null {
  if (!href.startsWith(WIKI_SCHEME)) return null
  const rest = href.slice(WIKI_SCHEME.length)
  const kind: LinkKind = rest.startsWith('md:') ? 'md' : 'wiki'
  const raw = kind === 'md' ? rest.slice(3) : rest
  try {
    return { target: decodeURIComponent(raw), kind }
  } catch {
    return { target: raw, kind }
  }
}

/**
 * 交给 markdown 渲染之前，把双链与本地 md 链接换成 `#xnp-wiki:` 锚点。
 * 点击处理在 PreviewPane 里。
 */
export function previewLinks(text: string): string {
  const refs = parseLinks(text)
  if (!refs.length) return text
  let out = text
  for (let i = refs.length - 1; i >= 0; i--) {
    const r = refs[i]
    const href = `${WIKI_SCHEME}${r.kind === 'md' ? 'md:' : ''}${encodeURIComponent(r.target)}`
    const label = r.label.replace(/([\[\]])/g, '\\$1')
    out = out.slice(0, r.from) + `[${label}](${href})` + out.slice(r.to)
  }
  return out
}

