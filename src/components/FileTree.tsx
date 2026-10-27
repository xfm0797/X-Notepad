import { useEffect, useRef, useState } from 'react'
import { copyText, type TreeNode } from '../lib/api'
import { baseName, parentOf } from '../lib/path'
import { useWorkspace, askNewEntry, askRename } from '../store/workspace'

function fileGlyph(node: TreeNode): string {
  if (node.isDir) return '▸'
  switch (node.ext) {
    case 'md':
      return '◈'
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'py':
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

interface MenuState {
  x: number
  y: number
  node: TreeNode | null
}

interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}

const MENU_W = 176

function ContextMenu({
  state,
  items,
  onClose
}: {
  state: MenuState
  items: MenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  // 靠近右/下边缘时翻转，避免菜单跑出窗口
  const left = Math.min(state.x, window.innerWidth - MENU_W - 8)
  const top = Math.min(state.y, window.innerHeight - items.length * 26 - 12)

  return (
    <div ref={ref} className="ctx-menu" style={{ left, top, width: MENU_W }} role="menu">
      {items.map((item, i) => (
        <button
          key={`${item.label}-${i}`}
          className={`ctx-item${item.danger ? ' danger' : ''}`}
          onClick={() => {
            onClose()
            item.onClick()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function Row({ node, depth, onMenu }: { node: TreeNode; depth: number; onMenu: (m: MenuState) => void }) {
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
        onContextMenu={e => {
          e.preventDefault()
          e.stopPropagation()
          // 右键目录顺手把它展开，符合直觉
          if (node.isDir) setOpen(true)
          onMenu({ x: e.clientX, y: e.clientY, node })
        }}
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
        (node.children ?? []).map(child => (
          <Row key={child.path} node={child} depth={depth + 1} onMenu={onMenu} />
        ))}
    </>
  )
}

export function FileTree() {
  const tree = useWorkspace(s => s.tree)
  const root = useWorkspace(s => s.root)
  const openFolder = useWorkspace(s => s.openFolder)
  const refreshTree = useWorkspace(s => s.refreshTree)
  const removeEntry = useWorkspace(s => s.removeEntry)
  const [menu, setMenu] = useState<MenuState | null>(null)

  /** 右键节点的"新建"目标目录：目录就是它自己，文件取父级，空白处取根 */
  const newDirOf = (node: TreeNode | null) => {
    if (!node) return root
    return node.isDir ? node.path : parentOf(node.path)
  }

  const menuItems = (state: MenuState): MenuItem[] => {
    const dir = newDirOf(state.node)
    const items: MenuItem[] = []
    if (dir) {
      items.push({ label: '新建文件', onClick: () => void askNewEntry(dir, 'file') })
      items.push({ label: '新建文件夹', onClick: () => void askNewEntry(dir, 'dir') })
    }
    if (state.node) {
      items.push({ label: '重命名', onClick: () => void askRename(state.node!.path) })
      items.push({ label: '复制路径', onClick: () => void copyText(state.node!.path) })
      items.push({
        label: '删除',
        danger: true,
        onClick: () => void removeEntry(state.node!.path)
      })
    }
    if (items.length) items.push({ label: '刷新', onClick: () => void refreshTree() })
    return items
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title" title={root ?? ''}>
          {root ? baseName(root) : '未打开文件夹'}
        </span>
        <span className="sidebar-actions">
          {root && (
            <>
              <button
                className="icon-btn"
                title="新建文件"
                onClick={() => void askNewEntry(root, 'file')}
              >
                ＋
              </button>
              <button
                className="icon-btn"
                title="新建文件夹"
                onClick={() => void askNewEntry(root, 'dir')}
              >
                ▤
              </button>
            </>
          )}
          <button className="icon-btn" title="刷新" onClick={() => void refreshTree()}>
            ↻
          </button>
        </span>
      </div>

      {root ? (
        <div
          className="tree"
          onContextMenu={e => {
            // 空白处右键 = 对根目录操作
            if (e.target !== e.currentTarget) return
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, node: null })
          }}
        >
          {tree.map(node => (
            <Row key={node.path} node={node} depth={0} onMenu={setMenu} />
          ))}
          {!tree.length && <div className="pane-empty small">空目录 — 右键新建第一个文件</div>}
        </div>
      ) : (
        <div className="sidebar-empty">
          <p>选一个文件夹开始</p>
          <button className="btn primary" onClick={() => void openFolder()}>
            打开文件夹
          </button>
        </div>
      )}

      {menu && <ContextMenu state={menu} items={menuItems(menu)} onClose={() => setMenu(null)} />}
    </aside>
  )
}
