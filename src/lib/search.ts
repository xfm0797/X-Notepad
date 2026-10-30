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

/** 一行上下文：行号 + 这一行的原文（命中处高亮） */
export interface SearchSpan {
  /** 1 起算 */
  line: number
  column: number
  snippet: SnippetSeg[]
  /** 这一行本身有命中；false 是两块命中之间补的上下文行 */
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
  /** 第一处命中的摘要 */
  snippet: SnippetSeg[]
  /** 每个命中行一行上下文（最多 MAX_SPANS 行） */
  spans: SearchSpan[]
  /** 有命中的总行数，可能大于 spans.length */
  spanTotal: number
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
  /** 正则模式：不走 FTS5，直接在正文上跑 regex */
  regex?: boolean
}

export interface ReplaceOptions {
  caseSensitive?: boolean
  regex?: boolean
  root?: string
  /** 有未保存修改的打开文件，别在磁盘上动它 */
  skip?: string[]
  dryRun?: boolean
}

export interface ReplaceReport {
  files: number
  replacements: number
  changed: Array<{ path: string; name: string; count: number }>
  skipped: Array<{ path: string; reason: string }>
  dryRun: boolean
  /** 这次替换的快照 id（撤销用）；dryRun 或没留底时为空 */
  snapshot?: string | null
  ms: number
}

export interface UndoReport {
  id: string
  /** 快照建立时间（秒） */
  at: number
  pattern: string
  replacement: string
  files: number
  restored: Array<{ path: string; name: string }>
  skipped: Array<{ path: string; reason: string }>
  /** 盘上本来就是替换前内容的文件数 */
  already: number
  ms: number
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

/* ------------------------------------------------------------------ */
/* 正则                                                                 */
/* ------------------------------------------------------------------ */

function reFlags(caseSensitive: boolean): string {
  return caseSensitive ? 'g' : 'gi'
}

/** 编译用户输入的正则；出错时给一句人话（桌面端由 Rust 侧报错） */
export function compilePattern(pattern: string, caseSensitive = false): RegExp {
  if (!pattern) throw new Error('正则表达式不能为空')
  try {
    return new RegExp(pattern, reFlags(caseSensitive))
  } catch (e) {
    throw new Error(`正则表达式无效：${String(e).replace(/^SyntaxError:\s*/, '')}`)
  }
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 逐次 exec 遍历匹配；零宽匹配（`^`、`\b`、lookahead）跳过，
 * 否则 lastIndex 不前进会死循环。
 */
export function forEachMatch(
  text: string,
  re: RegExp,
  visit: (start: number, end: number) => boolean | void
): void {
  re.lastIndex = 0
  let guard = 0
  for (;;) {
    const m = re.exec(text)
    if (!m) break
    const start = m.index
    const end = start + m[0].length
    if (m[0].length === 0) re.lastIndex = start + 1
    if (end > start && visit(start, end) === false) break
    if (++guard > 20000) break
  }
  re.lastIndex = 0
}

export function rangesInRegex(text: string, re: RegExp): Range[] {
  const found: Range[] = []
  forEachMatch(text, re, (s, e) => {
    found.push([s, e])
  })
  found.sort((a, b) => a[0] - b[0])
  const merged: Range[] = []
  for (const r of found) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

export function countRegex(text: string, re: RegExp): number {
  let n = 0
  forEachMatch(text, re, () => {
    n++
  })
  return n
}

function flatten(s: string): string {
  return s.replace(/\s+/g, ' ')
}

/** 以 anchor 为中心截一段，find 给出的命中处切成 hit 片段（换行压成空格，一行显示完） */
export function snippetBy(
  text: string,
  anchor: number,
  find: (win: string) => Range[],
  back = 60,
  fwd = 120
): SnippetSeg[] {
  const start = Math.max(0, anchor - back)
  const end = Math.min(text.length, anchor + fwd)
  const win = text.slice(start, end)

  const segs: SnippetSeg[] = []
  let cursor = 0
  for (const [s, e] of find(win)) {
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

/** 以 anchor 为中心截一段，命中处切成 hit 片段（换行压成空格，一行显示完） */
export function makeSnippet(
  text: string,
  anchor: number,
  terms: string[],
  caseSensitive = false,
  back = 60,
  fwd = 120
): SnippetSeg[] {
  return snippetBy(text, anchor, win => rangesIn(win, terms, caseSensitive), back, fwd)
}

/** 每个文件最多列多少行上下文，跟 Rust 侧 MAX_SPANS 对齐 */
export const MAX_SPANS = 20
/** 一行最多带多少字符的上下文，跟 Rust 侧 LINE_MAX 对齐 */
const LINE_MAX = 240
/** 截断时命中处前面留多少字符 */
const LINE_HEAD = 60
/** 两个命中行相差不到这么多行就合成一段，跟 Rust 侧 MERGE_GAP 对齐 */
export const MERGE_GAP = 3

interface RawLine {
  line: number
  start: number
  end: number
  ranges: Range[]
  cutBefore: boolean
  cutAfter: boolean
  hit: boolean
}

/**
 * 超长行按字符截一段（压缩过的 JSON / JS 一行能有几十万字符，
 * 原样塞进结果就是几十兆的 payload）。返回（窗口、前面截了没、后面截了没）。
 */
function clipLine(
  text: string,
  ts: number,
  te: number,
  anchor: number
): { start: number; end: number; cutBefore: boolean; cutAfter: boolean } {
  const line = text.slice(ts, te)
  const chars = Array.from(line)
  if (chars.length <= LINE_MAX) return { start: ts, end: te, cutBefore: false, cutAfter: false }

  const anchorChars = Array.from(text.slice(ts, Math.min(Math.max(anchor, ts), te))).length
  const from = Math.max(0, anchorChars - LINE_HEAD)
  const to = Math.min(chars.length, from + LINE_MAX)
  const start = ts + chars.slice(0, from).join('').length
  const end = ts + chars.slice(0, to).join('').length
  return { start, end, cutBefore: start > ts, cutAfter: end < te }
}

/** 行窗口里按区间切片（区间已是行内相对偏移，可能重叠） */
function segmentsOf(win: string, ranges: Range[]): SnippetSeg[] {
  const segs: SnippetSeg[] = []
  let cursor = 0
  for (const [s, e] of ranges) {
    if (s > cursor) segs.push({ text: win.slice(cursor, s), hit: false })
    if (e > s) segs.push({ text: win.slice(s, e), hit: true })
    cursor = Math.max(cursor, e)
  }
  if (cursor < win.length) segs.push({ text: win.slice(cursor), hit: false })
  if (!segs.length) segs.push({ text: win, hit: false })
  return segs
}

/**
 * 把全文命中区间折成「一行一条」的上下文。
 *
 * 跟 `src-tauri/src/lines.rs` 的 `group` 一一对应：演示模式（浏览器 / jsdom）
 * 和桌面端看到的行号、列号、缩进处理必须一模一样，否则同一份笔记两边对不上。
 *
 * 相邻的命中会连成一段——中间只隔 `MERGE_GAP - 1` 行以内时，那几行也补进来
 * （`hit: false`），于是「行号连续」就等于「同一段」，前端不必另存分组信息。
 */
export function spansOf(
  text: string,
  ranges: Range[],
  max = MAX_SPANS
): { spans: SearchSpan[]; spanTotal: number } {
  if (!text || !ranges.length || max <= 0) return { spans: [], spanTotal: 0 }

  const starts: number[] = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)

  const sorted = ranges
    .filter(([s, e]) => e > s && s < text.length)
    .sort((a, b) => a[0] - b[0])

  const raw: RawLine[] = []
  let spanTotal = 0
  // 已经建了窗口的命中行数（上下文行不算，否则 max 会被它们吃光）
  let built = 0
  // 上一段区间落在哪一行：超过上限后不再建窗口，但「这行算过了」得记住，
  // 否则同一行的后几处命中会被数成好几行
  let seen = -1
  // 最后一个进来的行（命中或上下文），用来判断下一处命中离得远不远
  let lastIdx = -1
  for (const [s, e] of sorted) {
    // 二分找命中起点所在的行
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= s) lo = mid
      else hi = mid - 1
    }
    const lineStart = starts[lo]
    const lineEnd = lo + 1 < starts.length ? starts[lo + 1] - 1 : text.length
    const end = Math.min(e, lineEnd)
    if (end <= lineStart) continue

    if (seen === lo) {
      const last = raw[raw.length - 1]
      if (last && last.hit && last.line === lo + 1) {
        const clampS = Math.max(s, last.start)
        const clampE = Math.min(end, last.end)
        if (clampE > clampS) last.ranges.push([clampS - last.start, clampE - last.start])
      }
      continue
    }
    seen = lo
    spanTotal++
    if (built >= max) continue
    built++

    // 跟上一行隔得近就把中间几行补成上下文，两处命中在界面上连成一段
    if (lastIdx >= 0) {
      const gap = lo - lastIdx - 1
      if (gap > 0 && gap < MERGE_GAP) {
        for (let k = 1; k <= gap; k++) raw.push(contextLine(text, starts, lastIdx + k))
      }
    }

    // 行首缩进、行尾空白都去掉，上下文从正文开始
    const lineText = text.slice(lineStart, lineEnd)
    const lead = lineText.length - lineText.replace(/^[ \t]+/, '').length
    const trimmed = lineText.replace(/[ \t\r]+$/, '')
    const ts = lineStart + lead
    const te = lineStart + Math.max(trimmed.length, lead)
    const clip = clipLine(text, ts, te, s)
    const item: RawLine = {
      line: lo + 1,
      start: clip.start,
      end: clip.end,
      ranges: [],
      cutBefore: clip.cutBefore,
      cutAfter: clip.cutAfter,
      hit: true
    }
    const clampS = Math.max(s, clip.start)
    const clampE = Math.min(end, clip.end)
    if (clampE > clampS) item.ranges.push([clampS - clip.start, clampE - clip.start])
    raw.push(item)
    lastIdx = lo
  }

  const spans: SearchSpan[] = raw.map(item => {
    const win = text.slice(item.start, item.end)
    const first = item.ranges[0]?.[0] ?? 0
    const segs = segmentsOf(win, item.ranges)
    if (item.cutBefore) segs[0] = { ...segs[0], text: `…${segs[0].text}` }
    if (item.cutAfter) segs[segs.length - 1] = { ...segs[segs.length - 1], text: `${segs[segs.length - 1].text}…` }
    return {
      line: item.line,
      // 列按字符算（不是 UTF-16 code unit），跟 Rust 侧一致
      column: Array.from(win.slice(0, first)).length + 1,
      snippet: segs,
      hit: item.hit
    }
  })
  return { spans, spanTotal }
}

/** 补一行上下文：没有高亮区间，超长就从行首截断 */
function contextLine(text: string, starts: number[], idx: number): RawLine {
  const lineStart = starts[idx]
  const lineEnd = idx + 1 < starts.length ? starts[idx + 1] - 1 : text.length
  const lineText = text.slice(lineStart, lineEnd)
  const lead = lineText.length - lineText.replace(/^[ \t]+/, '').length
  const trimmed = lineText.replace(/[ \t\r]+$/, '')
  const ts = lineStart + lead
  const te = lineStart + Math.max(trimmed.length, lead)
  const clip = clipLine(text, ts, te, ts)
  return {
    line: idx + 1,
    start: clip.start,
    end: clip.end,
    ranges: [],
    cutBefore: false,
    cutAfter: clip.cutAfter,
    hit: false
  }
}

/** 一段：行号连续的若干行（命中行 + 中间补的上下文） */
export interface SpanBlock {
  from: number
  to: number
  /** 这一段里有几行真命中 */
  hits: number
  spans: SearchSpan[]
  /** 与上一段之间跳过了几行；第一段为 0 */
  gap: number
}

/**
 * 顺着行号把上下文切成段：连着的算同一段，断开的地方给出「中间跳了几行」。
 * 段内可能一行命中都没有（理论上不会出现，兜底不至于崩）。
 */
export function foldSpans(spans: SearchSpan[]): SpanBlock[] {
  const blocks: SpanBlock[] = []
  for (const span of spans) {
    const last = blocks[blocks.length - 1]
    if (last && span.line === last.to + 1) {
      last.spans.push(span)
      last.to = span.line
      if (span.hit) last.hits++
      continue
    }
    blocks.push({
      from: span.line,
      to: span.line,
      hits: span.hit ? 1 : 0,
      spans: [span],
      gap: last ? span.line - last.to - 1 : 0
    })
  }
  return blocks
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

async function listDemoFiles(
  root: string
): Promise<Array<{ path: string; content: string; encoding: string; eol: 'LF' | 'CRLF' }>> {
  const tree = await api.readTree(root)
  const paths: string[] = []
  const walk = (nodes: api.TreeNode[]) => {
    for (const n of nodes) {
      if (n.isDir) walk(n.children ?? [])
      else paths.push(n.path)
    }
  }
  walk(tree)

  const out: Array<{ path: string; content: string; encoding: string; eol: 'LF' | 'CRLF' }> = []
  for (const p of paths) {
    try {
      const f = await api.readFile(p)
      if (!f.binary) out.push({ path: p, content: f.content, encoding: f.encoding, eol: f.eol })
    } catch {
      /* 读不了就跳过 */
    }
  }
  return out
}

async function queryLocal(root: string, query: string, opts: QueryOptions): Promise<SearchHit[]> {
  const caseSensitive = !!opts.caseSensitive
  const re = opts.regex ? compilePattern(query, caseSensitive) : null
  const terms = re ? [] : termsOf(query)
  if (!re && !terms.length) return []

  const limit = opts.limit ?? 200
  const hits: SearchHit[] = []

  for (const file of await listDemoFiles(root)) {
    const ranges = re
      ? rangesInRegex(file.content, re)
      : rangesIn(file.content, terms, caseSensitive)
    if (!ranges.length) continue
    const at = ranges[0][0]
    const { line, column } = lineColOf(file.content, at)
    const { spans, spanTotal } = spansOf(file.content, ranges)
    hits.push({
      path: file.path,
      name: baseName(file.path),
      score: -ranges.length,
      line,
      column,
      matches: re ? countRegex(file.content, re) : ranges.length,
      snippet: re
        ? snippetBy(file.content, at, win => rangesInRegex(win, re))
        : makeSnippet(file.content, at, terms, caseSensitive),
      spans,
      spanTotal
    })
    if (hits.length >= limit) break
  }

  hits.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
  return hits
}

/**
 * 浏览器演示模式没有 Rust 那套磁盘快照，就用内存里的一份底稿顶上：
 * 结构跟真实快照一样（每个文件存替换前 / 替换后的正文），撤销的判断也一样。
 */
interface DemoSpan {
  id: string
  at: number
  pattern: string
  replacement: string
  files: Array<{ path: string; name: string; before: string; after: string; encoding: string; eol: string }>
}

const demoSnaps: DemoSpan[] = []
const DEMO_KEEP = 20

async function replaceLocal(
  root: string,
  pattern: string,
  replacement: string,
  opts: ReplaceOptions
): Promise<ReplaceReport> {
  const started = Date.now()
  if (!pattern) throw new Error('查找内容不能为空')
  const caseSensitive = !!opts.caseSensitive
  const re = opts.regex
    ? compilePattern(pattern, caseSensitive)
    : new RegExp(escapeRe(pattern), reFlags(caseSensitive))

  const skip = new Set(opts.skip ?? [])
  const changed: ReplaceReport['changed'] = []
  const skipped: ReplaceReport['skipped'] = []
  const span: DemoSpan = {
    id: String(Date.now()),
    at: Math.round(Date.now() / 1000),
    pattern,
    replacement,
    files: []
  }
  let replacements = 0

  for (const file of await listDemoFiles(root)) {
    if (skip.has(file.path)) {
      skipped.push({ path: file.path, reason: '有未保存的修改' })
      continue
    }
    const count = countRegex(file.content, re)
    if (!count) continue
    // 正则模式下替换串按模板解释（$1），普通文本模式里 $ 就是字面量
    const next = opts.regex
      ? file.content.replace(re, replacement)
      : file.content.replace(re, () => replacement)
    if (!opts.dryRun) {
      await api.writeFile(file.path, next, file.encoding, file.eol)
      span.files.push({
        path: file.path,
        name: baseName(file.path),
        before: file.content,
        after: next,
        encoding: file.encoding,
        eol: file.eol
      })
    }
    replacements += count
    changed.push({ path: file.path, name: baseName(file.path), count })
  }

  changed.sort((a, b) => a.path.localeCompare(b.path))
  if (span.files.length) {
    demoSnaps.push(span)
    while (demoSnaps.length > DEMO_KEEP) demoSnaps.shift()
  }
  return {
    files: changed.length,
    replacements,
    changed,
    skipped,
    dryRun: !!opts.dryRun,
    snapshot: span.files.length ? span.id : null,
    ms: Date.now() - started
  }
}

async function undoLocal(id?: string): Promise<UndoReport> {
  const started = Date.now()
  const at = id ? demoSnaps.findIndex(s => s.id === id) : demoSnaps.length - 1
  const span = at >= 0 ? demoSnaps[at] : undefined
  if (!span) throw new Error('还没有可撤销的替换')
  demoSnaps.splice(at, 1)

  const restored: UndoReport['restored'] = []
  const skipped: UndoReport['skipped'] = []
  let already = 0
  for (const f of span.files) {
    let now: string
    try {
      now = (await api.readFile(f.path)).content
    } catch {
      skipped.push({ path: f.path, reason: '文件已删除' })
      continue
    }
    if (now === f.before) {
      already++
      continue
    }
    if (now !== f.after) {
      // 替换之后又改过：硬写回去会把新改动冲掉
      skipped.push({ path: f.path, reason: '替换后又被改过' })
      continue
    }
    await api.writeFile(f.path, f.before, f.encoding, f.eol)
    restored.push({ path: f.path, name: f.name })
  }
  restored.sort((a, b) => a.path.localeCompare(b.path))
  skipped.sort((a, b) => a.path.localeCompare(b.path))
  return {
    id: span.id,
    at: span.at,
    pattern: span.pattern,
    replacement: span.replacement,
    files: restored.length,
    restored,
    skipped,
    already,
    ms: Date.now() - started
  }
}

/* ------------------------------------------------------------------ */
/* 桌面端：invoke                                                      */
/* ------------------------------------------------------------------ */

export async function queryIndex(query: string, opts: QueryOptions = {}): Promise<SearchHit[]> {
  if (!api.isTauri) return queryLocal(opts.root ?? '/demo', query, opts)
  return invoke<SearchHit[]>('search_query', { query, options: opts })
}

/** 全库替换。dryRun=true 只统计数量，前端拿它去问用户「确定替换 N 处？」 */
export async function replaceAll(
  pattern: string,
  replacement: string,
  opts: ReplaceOptions = {}
): Promise<ReplaceReport> {
  if (!api.isTauri) return replaceLocal(opts.root ?? '/demo', pattern, replacement, opts)
  return invoke<ReplaceReport>('search_replace', { pattern, replacement, options: opts })
}

/** 撤销一次全库替换。不给 id 就撤最近那次，撤完这份快照就没了 */
export async function undoReplace(id?: string): Promise<UndoReport> {
  if (!api.isTauri) return undoLocal(id)
  return invoke<UndoReport>('search_replace_undo', { id: id ?? null })
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
