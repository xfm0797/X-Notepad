import { useState } from 'react'
import type { TreeNode } from '../lib/api'
import { useWorkspace } from '../store/workspace'

function fileGlyph(node: TreeNode): string {
  if (node.isDir) return '▸'
  switch (node.ext) {
    case 'md':
      return '◈'
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return '◆'
    case 'py':
      return '◆'
    case 'rs':
      return '◆'
    case 'json':
    case 'toml':
    case 'yaml':
    case 'yml':
      return '▤'
    default:
      return '·'
  }
}

function Row({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1)
  const active = useWorkspace(s => s.active)
  const dirty = useWorkspace(s => (s.docs[node.path] ? s.docs[node.path].content !== s.docs[node.path].savedContent : false))
  const openFile = useWorkspace(s => s.openFile)

  const isActive = active === node.path

  return (
    <>
      <div
        className={`tree-row${isActive ? ' active' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (node.isDir ? setOpen(o => !o) : void openFile(node.path))}
        title={node.path}
      >
        <span className={`tree-glyph${node.isDir ? ' dir' : ''}`}>
          {node.isDir ? (open ? '▾' : '▸') : fileGlyph(node)}
        </span>
        <span className="tree-name">{node.name}</span>
        {dirty && <span className="tree-dot" />}
      </div>
      {node.isDir &&
        open &&
        (node.children ?? []).map(child => <Row key={child.path} node={child} depth={depth + 1} />)}
    </>
  )
}

export function FileTree() {
  const tree = useWorkspace(s => s.tree)
  const root = useWorkspace(s => s.root)
  const openFolder = useWorkspace(s => s.openFolder)
  const refreshTree = useWorkspace(s => s.refreshTree)

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">{root ? root.split(/[\\/]/).pop() : '未打开文件夹'}</span>
        <button className="icon-btn" title="刷新" onClick={() => void refreshTree()}>
          ↻
        </button>
      </div>
      {root ? (
        <div className="tree">
          {tree.map(node => (
            <Row key={node.path} node={node} depth={0} />
          ))}
          {!tree.length && <div className="pane-empty small">空目录</div>}
        </div>
      ) : (
        <div className="sidebar-empty">
          <p>选一个文件夹开始</p>
          <button className="btn primary" onClick={() => void openFolder()}>
            打开文件夹
          </button>
        </div>
      )}
    </aside>
  )
}
