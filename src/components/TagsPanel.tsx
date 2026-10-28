import { useMemo, useState } from 'react'
import * as graphLib from '../lib/graph'
import { frontMatterTags } from '../lib/tags'
import { useWorkspace } from '../store/workspace'

interface Props {
  node: graphLib.GNode
}

/**
 * 标签面板。
 *
 * 「这篇的标签」只列 front-matter 里的（能改），正文里写的 `#标签` 另外标出来——
 * 那些属于原文，要删得去正文删，面板不越界。
 */
export function TagsPanel({ node }: Props) {
  const graph = useWorkspace(s => s.graph)
  const doc = useWorkspace(s => (s.active ? s.docs[s.active] : undefined))
  const tagFocus = useWorkspace(s => s.tagFocus)
  const setTagFocus = useWorkspace(s => s.setTagFocus)
  const addTag = useWorkspace(s => s.addTagToActive)
  const removeTag = useWorkspace(s => s.removeTagFromActive)
  const openFile = useWorkspace(s => s.openFile)

  const [draft, setDraft] = useState('')

  const own = useMemo(() => (doc ? frontMatterTags(doc.content) : []), [doc?.content])
  const inlineOnly = useMemo(() => {
    const lower = new Set(own.map(t => t.toLowerCase()))
    return node.tags.filter(t => !lower.has(t.toLowerCase()))
  }, [node.tags, own])

  const index = useMemo(() => graphLib.tagIndex(graph, node), [graph, node])
  const focused = useMemo(
    () => (tagFocus ? index.find(t => t.tag.toLowerCase() === tagFocus.toLowerCase()) ?? null : null),
    [index, tagFocus]
  )

  const submit = () => {
    const v = draft.trim()
    if (!v) return
    setDraft('')
    void addTag(v)
  }

  return (
    <div className="side-scroll">
      <div className="side-label">
        <span>这篇的标签</span>
        <span className="side-count">{own.length}</span>
      </div>
      {own.length === 0 && <div className="side-empty">还没有标签，下面输入一个回车即可</div>}
      <div className="tag-cloud">
        {own.map(t => (
          <span key={t} className="tag-chip">
            {t}
            <button className="tag-x" title="从 front-matter 里移除" onClick={() => void removeTag(t)}>
              ×
            </button>
          </span>
        ))}
        {inlineOnly.map(t => (
          <span key={t} className="tag-chip inline" title="这是正文里的 #标签，去正文删">
            #{t}
          </span>
        ))}
      </div>
      <input
        className="tag-input"
        value={draft}
        placeholder="加标签，回车确认"
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
      />

      <div className="side-label">
        <span>全部标签</span>
        <span className="side-count">{index.length}</span>
        {tagFocus && (
          <button className="side-mini" onClick={() => setTagFocus(null)} title="取消筛选">
            清除
          </button>
        )}
      </div>
      {index.length === 0 && <div className="side-empty">整个工作区还没有标签</div>}
      <div className="tag-cloud">
        {index.map(t => (
          <button
            key={t.tag}
            className={`tag-chip clickable${focused?.tag === t.tag ? ' on' : ''}`}
            onClick={() => setTagFocus(focused?.tag === t.tag ? null : t.tag)}
            title={`${t.count} 篇`}
          >
            {t.tag}
            <span className="tag-num">{t.count}</span>
          </button>
        ))}
      </div>

      {focused && (
        <>
          <div className="side-label">
            <span>#{focused.tag}</span>
            <span className="side-count">{focused.paths.length}</span>
          </div>
          {focused.paths.map(p => (
            <button key={p} className="link-item" title={p} onClick={() => void openFile(p)}>
              <span className="link-name">{p.split(/[\\/]/).pop()}</span>
              <span className="link-line">打开</span>
            </button>
          ))}
        </>
      )}
    </div>
  )
}
