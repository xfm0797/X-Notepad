import { useMemo } from 'react'
import * as graphLib from '../lib/graph'
import { useWorkspace } from '../store/workspace'
import { BacklinksPanel } from './BacklinksPanel'
import { OutlinePanel } from './OutlinePanel'
import { TagsPanel } from './TagsPanel'

type TabId = 'outline' | 'backlinks' | 'tags'

/**
 * 编辑器左边的信息栏：大纲 / 双链 / 标签三个页签。
 * 三块都只依赖当前文档的正文，所以共用一份节点（缓冲区内容，刚打的链接立刻算数）。
 */
export function SidePanel({ path, content }: { path: string; content: string }) {
  const side = useWorkspace(s => s.side)
  const setSide = useWorkspace(s => s.setSide)
  const jumpTo = useWorkspace(s => s.jumpTo)

  const node = useMemo(() => graphLib.nodeOf(path, content), [path, content])
  const headings = useMemo(() => countHeadings(content), [content])

  const tabs: Array<{ id: TabId; label: string; count: number }> = [
    { id: 'outline', label: '大纲', count: headings },
    { id: 'backlinks', label: '双链', count: node.links.length },
    { id: 'tags', label: '标签', count: node.tags.length }
  ]

  const active: TabId = side === 'none' ? 'outline' : side

  return (
    <aside className="side">
      <div className="side-tabs">
        {tabs.map(t => (
          <button
            key={t.id}
            className={`side-tab${active === t.id ? ' on' : ''}`}
            onClick={() => setSide(t.id)}
            title={t.id === 'outline' ? '标题大纲' : t.id === 'backlinks' ? '双链与反向链接' : '标签'}
          >
            {t.label}
            {t.count > 0 && <span className="side-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>
      <div className="side-body">
        {active === 'outline' && <OutlinePanel content={content} onJump={pos => jumpTo(path, pos)} />}
        {active === 'backlinks' && <BacklinksPanel node={node} />}
        {active === 'tags' && <TagsPanel node={node} />}
      </div>
    </aside>
  )
}

/** 大纲计数只为页签上的小数字，不必把整棵标题树建出来 */
function countHeadings(content: string): number {
  let n = 0
  for (const line of content.split('\n')) {
    if (/^#{1,6}[ \t]+\S/.test(line.trimStart())) n++
  }
  return n
}
