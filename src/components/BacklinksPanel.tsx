import { useMemo } from 'react'
import * as graphLib from '../lib/graph'
import { resolveLink } from '../lib/links'
import { useWorkspace } from '../store/workspace'

interface Props {
  node: graphLib.GNode
}

/**
 * 反链面板：谁引用了我（incoming）+ 我引用了谁（outgoing）。
 *
 * 出链找不到目标时显示成虚线，点一下可以就地新建——
 * 写笔记时「先写链接再写内容」是最常见的顺序。
 */
export function BacklinksPanel({ node }: Props) {
  const graph = useWorkspace(s => s.graph)
  const openAt = useWorkspace(s => s.openAt)
  const openWiki = useWorkspace(s => s.openWiki)
  const setLinkPicker = useWorkspace(s => s.setLinkPicker)

  const { outgoing, incoming } = useMemo(() => graphLib.around(graph, node), [graph, node])

  // 解析出链要的候选清单：全图 + 自己（自己链自己也算）
  const notes = useMemo(() => {
    const list = (graph?.nodes ?? [])
      .filter(n => n.path !== node.path)
      .map(n => ({ path: n.path, title: n.title }))
    list.push({ path: node.path, title: node.title })
    return list
  }, [graph, node])

  const outgoingRows = useMemo(
    () =>
      outgoing.map(l => ({
        link: l,
        hit: resolveLink(l.target, l.kind, node.path, notes)
      })),
    [outgoing, node.path, notes]
  )

  return (
    <div className="side-scroll">
      <div className="side-label">
        <span>反向链接</span>
        <span className="side-count">{incoming.length}</span>
      </div>
      {incoming.length === 0 && (
        <div className="side-empty">还没有别的笔记链到这里。在别处写 [[{node.title}]] 试试。</div>
      )}
      {incoming.map(b => (
        <button
          key={`${b.from}-${b.line}`}
          className="link-item"
          title={b.from}
          onClick={() => void openAt(b.from, b.line)}
        >
          <span className="link-name">{b.fromTitle}</span>
          <span className="link-line">第 {b.line} 行</span>
        </button>
      ))}

      <div className="side-label">
        <span>出链</span>
        <span className="side-count">{outgoing.length}</span>
        <button className="side-mini" onClick={() => setLinkPicker(true)} title="插入一个双链">
          ＋
        </button>
      </div>
      {outgoing.length === 0 && <div className="side-empty">这篇还没链到别处</div>}
      {outgoingRows.map(({ link, hit }, i) => (
        <button
          key={`${link.target}-${link.line}-${i}`}
          className={`link-item${hit ? '' : ' missing'}`}
          title={hit ?? `未解析：${link.target}`}
          onClick={() => void openWiki(link.target, link.kind, node.path)}
        >
          <span className="link-name">{link.label}</span>
          <span className="link-line">{hit ? `第 ${link.line} 行` : '未解析'}</span>
        </button>
      ))}
    </div>
  )
}
