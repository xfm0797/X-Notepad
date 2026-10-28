import { useEffect, useState } from 'react'
import { renderMarkdown } from '../lib/api'
import { parseWikiHref, previewLinks } from '../lib/links'
import { useWorkspace } from '../store/workspace'

interface Props {
  path: string
  content: string
}

/** Markdown 分屏预览：内容变化后 180ms 才渲染，避免每次击键都过一遍 comrak */
export function PreviewPane({ path, content }: Props) {
  const [html, setHtml] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    const timer = setTimeout(async () => {
      try {
        // 先把双链换成 `#xnp-wiki:` 锚点，再交给渲染器
        const raw = await renderMarkdown(previewLinks(content))
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

  // 预览里的双链点击：交给 store 解析目标、跳转或新建
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest('a')
    if (!target) return
    const wiki = parseWikiHref(target.getAttribute('href') ?? '')
    if (!wiki) return
    e.preventDefault()
    void useWorkspace.getState().openWiki(wiki.target, wiki.kind, path)
  }

  if (error) return <div className="pane-empty">预览渲染失败：{error}</div>

  return (
    <div className="preview-pane">
      <article className="markdown-body" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
