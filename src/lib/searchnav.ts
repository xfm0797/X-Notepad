/**
 * 搜索结果的键盘导航：把「文件 → 命中行」摊平成一串**位置**，
 * ↑↓ 顺着这串走，Enter 跳过去。
 *
 * 为什么按位置而不是按文件：同一个文件里常有五六处命中，
 * 先选中文件再去找第几行是两步；摊平之后一步到行。
 *
 * 只把**真有命中的行**算成位置：折叠视图里补出来的上下文行是给人读的，
 * 键盘停在上面会一顿一顿的（那些行本来就没命中，跳过去也没得改）。
 *
 * 顺序必须和渲染顺序一致：分组按 `groupHits` 的先后（相关度优先），
 * 组内按文件，文件内按行号。面板直接拿这个顺序做 `data-nav` 下标。
 */
import type { SearchHit } from './search'

export interface NavPos {
  /** 路径 + 行号：渲染时用它把按钮和位置对上 */
  key: string
  path: string
  name: string
  /** 1 起算 */
  line: number
  column: number
}

export function navKey(path: string, line: number): string {
  return `${path}\u0000${line}`
}

export function navPositions(hits: SearchHit[]): NavPos[] {
  const out: NavPos[] = []
  for (const hit of hits) {
    const lines = hit.spans.filter(s => s.hit)
    if (!lines.length) {
      // 没有逐行上下文（老调用方 / 只有路径命中）：文件本身就是一处位置
      out.push({
        key: navKey(hit.path, hit.line),
        path: hit.path,
        name: hit.name,
        line: hit.line,
        column: hit.column
      })
      continue
    }
    for (const span of lines) {
      out.push({
        key: navKey(hit.path, span.line),
        path: hit.path,
        name: hit.name,
        line: span.line,
        column: span.column
      })
    }
  }
  return out
}

/**
 * 走一步。到头就停住，**不绕回去**：绕回去会让人以为列表循环了，
 * 一路按到底反而回到开头，容易找不到自己看到哪儿了。
 * 还没有选中时（current < 0），向下从第一处起、向上从最后一处起。
 */
export function stepIndex(current: number, delta: number, total: number): number {
  if (total <= 0) return -1
  if (current < 0) return delta >= 0 ? 0 : total - 1
  return Math.max(0, Math.min(total - 1, current + delta))
}

/** 页脚那句：`3/12 · 第 42 行 · 想法.md` */
export function navLabel(pos: NavPos | undefined, index: number, total: number): string {
  if (!pos) return ''
  return `${index + 1}/${total} · 第 ${pos.line} 行 · ${pos.name}`
}
