import type { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

/**
 * 扩展名 → CodeMirror 语言。
 *
 * `@codemirror/language-data` 里每个语言都是 `LanguageDescription`，
 * 真正 `import()` 语言包要等 `load()` 时才发生，所以 100+ 语言不会拖慢启动。
 */
export function languageFor(ext: string): LanguageDescription | null {
  const e = ext.toLowerCase().replace(/^\./, '')
  if (!e) return null
  return (
    languages.find(l => l.extensions.includes(e)) ??
    languages.find(l => l.name.toLowerCase() === e) ??
    null
  )
}

const PLAIN = new Set(['txt', 'log', 'text', 'csv', 'tsv', 'ini', 'conf', 'env'])

export function isMarkdown(ext: string): boolean {
  return ['md', 'markdown', 'mdown', 'mkd'].includes(ext.toLowerCase().replace(/^\./, ''))
}

export function isPlain(ext: string): boolean {
  return PLAIN.has(ext.toLowerCase().replace(/^\./, ''))
}

/** 语言显示名，状态栏用 */
export function languageLabel(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, '')
  if (!e) return 'Plain Text'
  if (isMarkdown(e)) return 'Markdown'
  const found = languageFor(e)
  return found ? found.name : e.toUpperCase()
}
