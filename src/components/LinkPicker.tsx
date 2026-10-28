import { useEffect, useMemo, useRef, useState } from 'react'
import * as graphLib from '../lib/graph'
import { useWorkspace } from '../store/workspace'

/**
 * 插入双链的选择器：列出工作区里的笔记，回车把 `[[名字]]` 插到光标处。
 * 没有匹配项时提供一个「写成新链接」的选项——先写链接、之后再补内容，是很常见的写法。
 */
export function LinkPicker() {
  const graph = useWorkspace(s => s.graph)
  const doc = useWorkspace(s => (s.active ? s.docs[s.active] : undefined))
  const insertWiki = useWorkspace(s => s.insertWiki)
  const close = useWorkspace(s => s.setLinkPicker)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const node = useMemo(() => (doc ? graphLib.nodeOf(doc.path, doc.content) : null), [doc?.path, doc?.content])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = (graph?.nodes ?? []).filter(n => n.path !== node?.path)
    const hit = q
      ? all.filter(n => n.name.toLowerCase().includes(q) || n.title.toLowerCase().includes(q))
      : all
    const sorted = hit.slice().sort((a, b) => {
      // 名字以查询开头的排前面，其余按名字
      const ax = a.name.toLowerCase().startsWith(q) ? 0 : 1
      const bx = b.name.toLowerCase().startsWith(q) ? 0 : 1
      return ax - bx || a.name.localeCompare(b.name)
    })
    return sorted.slice(0, 40)
  }, [graph, node?.path, query])

  const trimmed = query.trim()
  const canCreate = !!trimmed && !items.some(n => n.name.toLowerCase() === `${trimmed.toLowerCase()}.md`)

  const run = (pick: string) => {
    if (!pick) return
    insertWiki(pick)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const total = items.length + (canCreate ? 1 : 0)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(c => (total ? (c + 1) % total : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(c => (total ? (c - 1 + total) % total : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (cursor < items.length) run(items[cursor].name)
      else if (canCreate) run(trimmed)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close(false)
    }
  }

  return (
    <div className="palette-overlay" onMouseDown={() => close(false)}>
      <div className="palette" onMouseDown={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="插入双链：输入笔记名…"
          onChange={e => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && !canCreate && <div className="palette-empty">工作区里还没有别的笔记</div>}
          {items.map((n, i) => (
            <div
              key={n.path}
              className={`palette-item${i === cursor ? ' active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => run(n.name)}
            >
              <span className="palette-label">{n.name.replace(/\.md$/i, '')}</span>
              {n.title !== n.name.replace(/\.md$/i, '') && <span className="palette-sub">{n.title}</span>}
            </div>
          ))}
          {canCreate && (
            <div
              className={`palette-item${cursor === items.length ? ' active' : ''}`}
              onMouseEnter={() => setCursor(items.length)}
              onClick={() => run(trimmed)}
            >
              <span className="palette-label">写成新链接</span>
              <span className="palette-sub">[[{trimmed}]]</span>
            </div>
          )}
        </div>
        <div className="palette-foot">
          <span>↑↓ 选择 · Enter 插入 · Esc 关闭</span>
          <span className="palette-foot-hint">{node ? node.name : '未打开文件'}</span>
        </div>
      </div>
    </div>
  )
}
