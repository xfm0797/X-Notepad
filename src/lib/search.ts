/**
 * 全文搜索的前端封装。
 *
 * 桌面端一律走 Rust（SQLite FTS5 索引），浏览器演示模式没有后端，
 * 就用同一套「找区间 → 拼摘要」的逻辑在内存里扫一遍演示文件，
 * 这样 UI 可以独立调试，jsdom 冒烟也能测到搜索面板。
 */
import { invoke } from '@tauri-apps/api/core'
import * as api from './api'
import { baseName } from './path'

export interface SnippetSeg {
  text: string
  hit: boolean
}

export interface SearchHit {
  path: string
  name: string
  /** bm25，越负越相关 */
  score: number
  /** 1 起算 */
  line: number
  column: number
  /** 该文件里命中的总次数 */
  matches: number
  snippet: SnippetSeg[]
}

export interface IndexStatus {
  files: number
  builtAt: number
  root: string
  ms?: number
  added?: number
  updated?: number
  removed?: number
}

export interface QueryOptions {
  caseSensitive?: boolean
  limit?: number
  root?: string
}

/** 一个词的命中区间 [start, end)，UTF-16 下标 */
export type Range = [number, number]

export function termsOf(query: string): string[] {
  return query
    .split(/\s+/)
    .map(t => t.replace(/\*+$/, ''))
    .filter(Boolean)
}

/**
 * 找出所有命中并合并重叠区间。
 * 大小写不敏感时用 toLowerCase 对齐下标（演示模式够用，桌面端在 Rust 里做）。
 */
const WORD = /[A-Za-z0-9_]/
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

export function rangesIn(text: string, terms: string[], caseSensitive = false): Range[] {
  const hay = caseSensitive ? text : text.toLowerCase()
  const found: Range[] = []
  for (const raw of terms) {
    const needle = caseSensitive ? raw : raw.toLowerCase()
    if (!needle) continue
    // 英文 / 数字按「词首前缀」匹配，和 Rust 侧 FTS5 的 `"note"*` 对齐；
    // 中文按子串匹配（Rust 侧是逐字短语，效果等价）
    const wordTerm = !CJK.test(raw) && /^[\w.\-]+$/.test(raw)
    let at = 0
    while (at <= hay.length - needle.length) {
      const i = hay.indexOf(needle, at)
      if (i < 0) break
      at = i + Math.max(needle.length, 1)
      if (wordTerm) {
        if (i > 0 && WORD.test(hay[i - 1])) continue
        let end = i + needle.length
        while (end < hay.length && WORD.test(hay[end])) end++
        found.push([i, end])
      } else {
        found.push([i, i + needle.length])
      }
    }
  }
  found.sort((a, b) => a[0] - b[0])
  const merged: Range[] = []
  for (const r of found) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

function flatten(s: string): string {
  return s.replace(/\s+/g, ' ')
}

/** 以 anchor 为中心截一段，命中处切成 hit 片段（换行压成空格，一行显示完） */
export function makeSnippet(
  text: string,
  anchor: number,
  terms: string[],
  caseSensitive = false,
  back = 60,
  fwd = 120
): SnippetSeg[] {
  const start = Math.max(0, anchor - back)
  const end = Math.min(text.length, anchor + fwd)
  const win = text.slice(start, end)

  const segs: SnippetSeg[] = []
  let cursor = 0
  for (const [s, e] of rangesIn(win, terms, caseSensitive)) {
    if (s > cursor) {
      const piece = flatten(win.slice(cursor, s))
      if (piece.trim()) segs.push({ text: piece, hit: false })
    }
    const piece = flatten(win.slice(s, e))
    if (piece) segs.push({ text: piece, hit: true })
    cursor = e
  }
  if (cursor < win.length) {
    const piece = flatten(win.slice(cursor))
    if (piece.trim()) segs.push({ text: piece, hit: false })
  }
  if (!segs.length) segs.push({ text: flatten(win), hit: false })
  if (start > 0) segs[0] = { ...segs[0], text: `…${segs[0].text.replace(/^\s+/, '')}` }
  const last = segs[segs.length - 1]
  if (end < text.length) segs[segs.length - 1] = { ...last, text: `${last.text.replace(/\s+$/, '')}…` }
  return segs
}

export function lineColOf(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index)
  const line = before.split('\n').length
  const nl = before.lastIndexOf('\n')
  // 列按「字符」算，和 Rust 侧一致（不是 UTF-16 code unit）
  const column = Array.from(before.slice(nl + 1)).length + 1
  return { line, column }
}

/**
 * 行号 + 列号（都从 1 起、按字符算）→ 字符串偏移。
 * 文件可能是 CRLF，所以只在 '\n' 处换行，顺便跳过行尾的 '\r'。
 */
export function offsetOf(text: string, line: number, column: number): number {
  let idx = 0
  let l = 1
  while (idx < text.length && l < line) {
    if (text.charCodeAt(idx) === 10) l++
    idx++
  }
  let c = 1
  while (idx < text.length && c < column) {
    const code = text.charCodeAt(idx)
    if (code === 10) break
    const size = code >= 0xd800 && code <= 0xdbff ? 2 : 1
    idx += size
    c++
  }
  return Math.min(idx, text.length)
}

/* ------------------------------------------------------------------ */
/* 浏览器演示模式：内存里扫一遍                                        */
/* ------------------------------------------------------------------ */

async function listDemoFiles(root: string): Promise<Array<{ path: string; content: string }>> {
  const tree = await api.readTree(root)
  const paths: string[] = []
  const walk = (nodes: api.TreeNode[]) => {
    for (const n of nodes) {
      if (n.isDir) walk(n.children ?? [])
      else paths.push(n.path)
    }
  }
  walk(tree)

  const out: Array<{ path: string; content: string }> = []
  for (const p of paths) {
    try {
      const f = await api.readFile(p)
      if (!f.binary) out.push({ path: p, content: f.content })
    } catch {
      /* 读不了就跳过 */
    }
  }
  return out
}

async function queryLocal(root: string, query: string, opts: QueryOptions): Promise<SearchHit[]> {
  const terms = termsOf(query)
  if (!terms.length) return []

  const limit = opts.limit ?? 200
  const caseSensitive = !!opts.caseSensitive
  const hits: SearchHit[] = []

  for (const file of await listDemoFiles(root)) {
    const ranges = rangesIn(file.content, terms, caseSensitive)
    if (!ranges.length) continue
    const at = ranges[0][0]
    const { line, column } = lineColOf(file.content, at)
    hits.push({
      path: file.path,
      name: baseName(file.path),
      score: -ranges.length,
      line,
      column,
      matches: ranges.length,
      snippet: makeSnippet(file.content, at, terms, caseSensitive)
    })
    if (hits.length >= limit) break
  }

  hits.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
  return hits
}

/* ------------------------------------------------------------------ */
/* 桌面端：invoke                                                      */
/* ------------------------------------------------------------------ */

export async function queryIndex(query: string, opts: QueryOptions = {}): Promise<SearchHit[]> {
  if (!api.isTauri) return queryLocal(opts.root ?? '/demo', query, opts)
  return invoke<SearchHit[]>('search_query', { query, options: opts })
}

export async function buildIndex(root: string): Promise<IndexStatus> {
  if (!api.isTauri) {
    const files = await listDemoFiles(root)
    return { files: files.length, builtAt: Date.now() / 1000, root, ms: 0, added: files.length }
  }
  return invoke<IndexStatus>('search_build', { root })
}

export async function updateIndex(path: string, root?: string): Promise<void> {
  if (!api.isTauri) return
  // root 显式给 null：让 Rust 侧回退到索引里记着的工作区
  await invoke('search_update', { path, root: root ?? null })
}

export async function removeIndex(path: string): Promise<void> {
  if (!api.isTauri) return
  await invoke('search_remove', { path })
}

export async function indexStatus(): Promise<IndexStatus | null> {
  if (!api.isTauri) {
    const files = await listDemoFiles('/demo')
    return { files: files.length, builtAt: Date.now() / 1000, root: '/demo' }
  }
  try {
    return await invoke<IndexStatus>('search_status')
  } catch {
    return null
  }
}
