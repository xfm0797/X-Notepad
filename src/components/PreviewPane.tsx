import { useEffect, useState } from 'react'
import { renderMarkdown } from '../lib/api'

interface Props {
  content: string
}

/** Markdown 分屏预览：内容变化后 180ms 才渲染，避免每次击键都过一遍 comrak */
export function PreviewPane({ content }: Props) {
  const [html, setHtml] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    const timer = setTimeout(async () => {
      try {
        const raw = await renderMarkdown(content)
        const { default: DOMPurify } = await import('dompurify')
        if (alive) {
          setHtml(DOMPurify.sanitize(raw))
          setError('')
        }
      } catch (e) {
        if (alive) setError(String(e).replace(/^Error:\s*/, ''))
      }
    }, 180)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [content])

  if (error) return <div className="pane-empty">预览渲染失败：{error}</div>

  return (
    <div className="preview-pane">
      <article className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
