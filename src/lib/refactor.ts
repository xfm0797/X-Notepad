/**
 * 引用改写：笔记改名时，把全库指向它的链接一起改掉。
 *
 * 双链用名字指代文件（`[[想法]]`），所以文件一改名，所有引用都会断。
 * 手工去改不现实，这里把「哪些文件的哪些位置要换成什么」先算清楚，
 * 交给 store 弹一次确认、再一次性落盘。
 *
 * 只改**指向被改名文件**的那些链接：
 * - `[[想法]]` → `[[新想法]]`
 * - `[[想法|我的想法]]` → `[[新想法|我的想法]]`（别名是作者写的，不动）
 * - `[[notes/想法#小节]]` → `[[notes/新想法#小节]]`（目录与锚点都不动）
 * - `[文字](notes/想法.md)` → `[文字](notes/新想法.md)`
 *
 * 判断「指向」用的是改名**之前**的图：改名后就解析不到了。
 */
import { noteName, parseLinks, resolveLink, type LinkKind, type NoteNode } from './links'

/** 一处待改写的链接 */
export interface RefEdit {
  /** 原文字符偏移 */
  from: number
  to: number
  /** 替换成什么 */
  text: string
  /** 改之前的原文，弹窗里给人看 */
  before: string
}

/** 一个文件要改的全部位置 */
export interface RefPlan {
  path: string
  /** 计划基于的正文。落盘前若缓冲区变了，就拿新正文重算一遍 */
  text: string
  edits: RefEdit[]
  /** 被改名的文件（绝对路径），重算时还要用 */
  target: string
  /** 新名字（不带 .md） */
  newStem: string
  /** 改名前的全库清单，重算时还要用 */
  notes: NoteNode[]
}

/* ------------------------------------------------------------------ */
/* 改一条链接                                                          */
/* ------------------------------------------------------------------ */

/** 把路径末段的名字换掉，目录前缀 / `#anchor` / `.md` 后缀都保留 */
function swapStem(pathPart: string, oldStem: string, newStem: string): string | null {
  const segs = pathPart.split('/')
  const last = segs[segs.length - 1]
  const bare = last.replace(/\.md$/i, '')
  if (bare.toLowerCase() !== oldStem.toLowerCase()) return null
  segs[segs.length - 1] = last.endsWith('.md') ? `${newStem}.md` : newStem
  return segs.join('/')
}

function splitAnchor(s: string): [string, string] {
  const i = s.indexOf('#')
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i)]
}

/**
 * 改写单条链接的原文。目标不是旧名字就返回 null。
 *
 * 只动「末段名字」，所以 `[[notes/想法]]` 这种带目录的写法不会把目录弄丢。
 */
export function retarget(raw: string, kind: LinkKind, oldStem: string, newStem: string): string | null {
  if (kind === 'wiki') {
    if (!raw.startsWith('[[') || !raw.endsWith(']]')) return null
    const inner = raw.slice(2, -2)
    const bar = inner.indexOf('|')
    const head = bar >= 0 ? inner.slice(0, bar) : inner
    const alias = bar >= 0 ? inner.slice(bar) : ''
    const [pathPart, anchor] = splitAnchor(head.trim())
    const next = swapStem(pathPart, oldStem, newStem)
    if (!next) return null
    return `[[${next}${anchor}${alias}]]`
  }

  const m = /^\[([^\]\n]*)\]\(([^)\s]+)\)$/.exec(raw)
  if (!m) return null
  const [href, anchor] = splitAnchor(m[2])
  // 外链、站内锚点、绝对路径都不指向工作区里的文件，原样留着
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) return null
  const next = swapStem(href, oldStem, newStem)
  if (!next) return null
  return `[${m[1]}](${next}${anchor})`
}

/* ------------------------------------------------------------------ */
/* 扫一个文件                                                          */
/* ------------------------------------------------------------------ */

/**
 * 算出 `text` 里所有指向 `target` 的链接该怎么改。
 *
 * `notes` 必须是**改名之前**的全库清单——否则 `[[旧名]]` 已经解析不到任何文件了。
 */
export function planText(
  text: string,
  fromPath: string,
  target: string,
  newStem: string,
  notes: NoteNode[]
): RefEdit[] {
  const oldStem = noteName(target)
  const out: RefEdit[] = []
  for (const ref of parseLinks(text)) {
    if (resolveLink(ref.target, ref.kind, fromPath, notes) !== target) continue
    const next = retarget(ref.raw, ref.kind, oldStem, newStem)
    if (!next || next === ref.raw) continue
    out.push({ from: ref.from, to: ref.to, text: next, before: ref.raw })
  }
  return out
}

/** 把若干编辑应用到正文上。偏移是原始正文里的，所以从后往前替换 */
export function applyEdits(text: string, edits: RefEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.from - a.from)
  let out = text
  for (const e of sorted) out = out.slice(0, e.from) + e.text + out.slice(e.to)
  return out
}

/** 这个文件里有没有提到过目标（`planText` 之前先粗筛，省一次磁盘读） */
export function mayReference(links: Array<{ target: string; kind: LinkKind }>, fromPath: string, target: string, notes: NoteNode[]): boolean {
  return links.some(l => resolveLink(l.target, l.kind, fromPath, notes) === target)
}

/** 弹窗里显示的名字：`notes/想法.md` → `想法.md` */
export function planLabel(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** 一句话概括方案：「N 个文件 M 处」 */
export function planSummary(plans: RefPlan[]): { files: number; edits: number } {
  return {
    files: plans.length,
    edits: plans.reduce((n, p) => n + p.edits.length, 0)
  }
}

/** 去掉扩展名，重命名时算新名字用 */
export function stemOf(name: string): string {
  return name.replace(/\.md$/i, '')
}
