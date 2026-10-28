/**
 * Markdown 大纲：只认 ATX 标题（`#` ~ `######`），跳过代码块里的 `#` 注释。
 *
 * 不做完整 Markdown 解析——大纲要的是"文档骨架"，而不是渲染结果，
 * 所以宁可轻一点：一行一行扫，遇到 ``` / ~~~ 就整段忽略。
 */

export interface Heading {
  level: number
  text: string
  /** 在文档里的字符偏移，用来让编辑器跳过去 */
  pos: number
  /** 1 起的行号，状态栏/提示里显示 */
  line: number
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const ATX = /^\s{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/

/** 去掉标题里的行内标记，只留文字 */
function plain(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
}

export function parseOutline(markdown: string): Heading[] {
  const out: Heading[] = []
  let offset = 0
  let fence: string | null = null

  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const start = offset
    offset += line.length + 1 // 换行符占 1（CRLF 在读取时已归一成 LF）

    const f = line.match(FENCE)
    if (f) {
      const mark = f[1][0]
      if (!fence) fence = mark
      else if (fence === mark) fence = null
      continue
    }
    if (fence) continue

    const m = line.match(ATX)
    if (!m) continue
    const text = plain(m[2])
    if (!text) continue
    out.push({ level: m[1].length, text, pos: start, line: i + 1 })
  }
  return out
}

/** 面板收起时也要知道有没有标题（决定按钮是否可点） */
export function hasOutline(markdown: string): boolean {
  return parseOutline(markdown).length > 0
}
