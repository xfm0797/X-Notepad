/**
 * 路径工具。
 *
 * 后端返回的是平台原生路径（Windows 用 `\`，macOS/Linux 用 `/`），
 * 前端只做字符串拼接，不引入 node:path，所以分隔符跟着原路径走。
 */

export function sepOf(p: string): string {
  return p.includes('\\') ? '\\' : '/'
}

/** 去掉末尾分隔符（根路径 `/` 与 `C:\` 保留） */
export function trimEnd(p: string): string {
  if (p === '/' || /^[A-Za-z]:[\\/]$/.test(p)) return p
  return p.replace(/[\\/]+$/, '')
}

export function baseName(p: string): string {
  const parts = trimEnd(p).split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function parentOf(p: string): string {
  const t = trimEnd(p)
  const idx = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'))
  if (idx < 0) return t
  if (idx === 0) return '/'
  // Windows 盘符根：C:\a 的父级是 C:\
  if (idx === 2 && /^[A-Za-z]:[\\/]/.test(t)) return t.slice(0, 3)
  return t.slice(0, idx)
}

export function joinPath(dir: string, name: string): string {
  return `${trimEnd(dir)}${sepOf(dir)}${name}`
}

/** child 是否等于 parent 或位于 parent 之下 */
export function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true
  const p = trimEnd(parent)
  return child.startsWith(`${p}/`) || child.startsWith(`${p}\\`)
}

/** 文件名合法性校验，返回错误文案或 null */
export function validateName(name: string): string | null {
  const v = name.trim()
  if (!v) return '名称不能为空'
  if (v === '.' || v === '..') return '名称不能是 . 或 ..'
  if (/[\\/:*?"<>|]/.test(v)) return '不能包含 \\ / : * ? " < > |'
  // Windows 保留名
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(v)) return '这是系统保留名称'
  return null
}
