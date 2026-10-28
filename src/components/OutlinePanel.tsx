import { useMemo } from 'react'
import { parseOutline } from '../lib/outline'

interface Props {
  content: string
  onJump: (pos: number) => void
}

/** Markdown 大纲。点击标题把编辑器选区挪过去，位置来自字符偏移，不依赖预览 DOM */
export function OutlinePanel({ content, onJump }: Props) {
  const headings = useMemo(() => parseOutline(content), [content])

  return (
    <div className="side-scroll">
      {headings.length === 0 && <div className="side-empty">这篇没有标题</div>}
      {headings.map(h => (
        <button
          key={`${h.pos}-${h.level}`}
          className={`outline-item l${h.level}`}
          style={{ paddingLeft: 10 + (h.level - 1) * 12 }}
          title={`第 ${h.line} 行 · ${h.text}`}
          onClick={() => onJump(h.pos)}
        >
          {h.text}
        </button>
      ))}
    </div>
  )
}
