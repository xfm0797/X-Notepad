/**
 * 标签：front-matter 里的 `tags: [a, b]` + 正文里的 `#标签`。
 *
 * 两处都收，是因为笔记软件里两种写法都常见：front-matter 适合"正式"归类，
 * 正文 `#标签` 适合写的时候顺手打。面板把它们合成一个集合，
 * 但**只有 front-matter 能被面板改写**——正文里的 `#标签` 属于原文，不去动它。
 */
import { maskCode } from './links'

/** front-matter 拆成「块内容 + 后面的正文」 */
export interface Split {
  /** 没有 front-matter 时为 null */
  body: string | null
  rest: string
}

/** 标签名合法性：不含空白和 YAML 记号，长度 1..40 */
export function cleanTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .replace(/[,\[\]{}#]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40)
}

/** 去重（忽略大小写，保留第一次出现的写法），并剔掉空标签 */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tags) {
    const v = cleanTag(t)
    if (!v) continue
    const k = v.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(v)
  }
  return out
}

/** 按行拆 front-matter；不是 `---` 开头就当没有 */
export function splitFrontMatter(text: string): Split {
  const firstNl = text.indexOf('\n')
  if (firstNl < 0 || text.slice(0, firstNl).trim() !== '---') return { body: null, rest: text }
  let pos = firstNl + 1
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos)
    const lineEnd = nl < 0 ? text.length : nl
    if (text.slice(pos, lineEnd).trim() === '---') {
      return {
        body: text.slice(firstNl + 1, pos),
        rest: text.slice(nl < 0 ? text.length : nl + 1)
      }
    }
    if (nl < 0) break
    pos = nl + 1
  }
  return { body: null, rest: text }
}

function stripQuotes(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

/** front-matter 里的 tags：支持 `[a, b]`、`a, b` 和 `- a` 列表两种写法 */
function tagsFromYaml(body: string): string[] {
  const lines = body.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*tags?\s*:\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const inline = m[1].trim()
    if (inline) {
      const inner = inline.replace(/^\[/, '').replace(/\]$/, '')
      for (const part of inner.split(',')) out.push(stripQuotes(part))
      continue
    }
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s*-\s+(.+)$/.exec(lines[j])
      if (!item) {
        if (lines[j].trim() === '') continue
        break
      }
      out.push(stripQuotes(item[1]))
    }
  }
  return out
}

const INLINE = /(^|[\s\p{P}])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]{0,39})/gmu

/** 全文标签：front-matter 的 + 正文 `#标签` */
export function parseTags(text: string): string[] {
  const split = splitFrontMatter(text)
  const out: string[] = []
  if (split.body != null) out.push(...tagsFromYaml(split.body))

  // 正文里找 `#标签`：front-matter 和代码块都要先蒙掉
  const masked = maskCode(text)
  const bodyStart = text.length - split.rest.length
  const scan = masked.slice(0, bodyStart).replace(/[^\n]/g, ' ') + masked.slice(bodyStart)
  for (const m of scan.matchAll(INLINE)) {
    const tag = m[2]
    if (/^\d+$/.test(tag)) continue // #1 这种编号不算标签
    out.push(tag)
  }
  return normalizeTags(out)
}

/** 只取 front-matter 里的标签（面板改写的是这一份） */
export function frontMatterTags(text: string): string[] {
  const split = splitFrontMatter(text)
  return split.body == null ? [] : normalizeTags(tagsFromYaml(split.body))
}

function yamlScalar(tag: string): string {
  return /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5./-]*$/.test(tag) ? tag : JSON.stringify(tag)
}

function tagsKeyIndex(lines: string[]): number {
  return lines.findIndex(l => /^\s*tags?\s*:/.test(l))
}

/** 找到从 tags: 开始、属于它的那些行（块列表要连子项一起算） */
function keyBlockEnd(lines: string[], start: number): number {
  const inline = /^\s*tags?\s*:\s*(.*)$/.exec(lines[start])?.[1].trim()
  if (inline) return start + 1
  let end = start + 1
  while (end < lines.length) {
    if (/^\s*-\s+/.test(lines[end])) {
      end++
      continue
    }
    if (lines[end].trim() === '') {
      end++
      continue
    }
    break
  }
  // 块末尾的空行留给后面的键，不要吞掉
  while (end > start + 1 && lines[end - 1].trim() === '') end--
  return end
}

/**
 * 改写 front-matter 里的 tags，正文一个字都不动。
 * 没有 front-matter 而 tags 非空时，在最前面补一个。
 */
export function setTags(text: string, tags: string[]): string {
  const list = normalizeTags(tags)
  const split = splitFrontMatter(text)

  if (split.body == null) {
    if (!list.length) return text
    const block = `---\ntags: [${list.map(yamlScalar).join(', ')}]\n---\n`
    return text.startsWith('\n') ? `${block}${text}` : `${block}\n${text}`
  }

  const lines = split.body.replace(/\n+$/, '').split('\n')
  const at = tagsKeyIndex(lines)
  let next = lines.slice()
  let insertAt = lines.length

  if (at >= 0) {
    const end = keyBlockEnd(lines, at)
    next = [...lines.slice(0, at), ...lines.slice(end)]
    insertAt = Math.min(at, next.length)
  }
  if (list.length) {
    next.splice(insertAt, 0, `tags: [${list.map(yamlScalar).join(', ')}]`)
  }

  // tags 是唯一一个键、又被清空了：整块 front-matter 一起收掉，别留个空壳
  if (!next.some(l => l.trim() !== '')) {
    return split.rest.replace(/^\n+/, '')
  }
  return `---\n${next.join('\n').replace(/\n+$/, '')}\n---\n${split.rest}`
}

/** 加一个标签（已存在就原样返回） */
export function addTag(text: string, tag: string): string {
  return setTags(text, [...frontMatterTags(text), cleanTag(tag)])
}

/** 去掉一个标签 */
export function removeTag(text: string, tag: string): string {
  const want = tag.toLowerCase()
  return setTags(
    text,
    frontMatterTags(text).filter(t => t.toLowerCase() !== want)
  )
}
