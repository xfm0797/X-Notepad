import { isMarkdown } from '../lib/lang'
import { useWorkspace } from '../store/workspace'

interface Props {
  onTogglePlugins: () => void
  pluginsOpen: boolean
  onOpenPalette: () => void
  onNewWindow: () => void
}

export function Toolbar({ onTogglePlugins, pluginsOpen, onOpenPalette, onNewWindow }: Props) {
  const openFolder = useWorkspace(s => s.openFolder)
  const save = useWorkspace(s => s.save)
  const saveAll = useWorkspace(s => s.saveAll)
  const togglePreview = useWorkspace(s => s.togglePreview)
  const toggleWrap = useWorkspace(s => s.toggleWrap)
  const toggleSide = useWorkspace(s => s.toggleSide)
  const toggleSearch = useWorkspace(s => s.toggleSearch)
  const searchOpen = useWorkspace(s => s.searchOpen)
  const preview = useWorkspace(s => s.preview)
  const wrap = useWorkspace(s => s.wrap)
  const side = useWorkspace(s => s.side)
  const theme = useWorkspace(s => s.theme)
  const setTheme = useWorkspace(s => s.setTheme)
  const active = useWorkspace(s => s.active)
  const doc = useWorkspace(s => (s.active ? s.docs[s.active] : undefined))

  const isMd = !!doc && isMarkdown(doc.name.split('.').pop() ?? '')

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark">X</span>
        <span className="brand-name">X-Notepad</span>
      </div>

      <div className="toolbar-group">
        <button className="btn" onClick={onOpenPalette} title="命令面板 (Ctrl+P)：搜命令也能直接搜文件">
          ⌘ 命令
        </button>
        <button
          className={`btn${searchOpen ? ' on' : ''}`}
          onClick={toggleSearch}
          title="全文搜索 (Ctrl+Shift+F)：搜正文内容"
        >
          🔍 全文
        </button>
        <button className="btn" onClick={() => void openFolder()} title="打开文件夹 (选一个目录作为工作区)">
          📂 打开
        </button>
        <button className="btn" disabled={!active} onClick={() => void save()} title="保存 (Ctrl+S)">
          💾 保存
        </button>
        <button className="btn" onClick={() => void saveAll()} title="保存全部">
          保存全部
        </button>
        <button className="btn" onClick={onNewWindow} title="新建窗口 (Ctrl+Alt+N)：每个窗口独立的工作区与标签">
          ⧉ 新窗口
        </button>
      </div>

      <div className="toolbar-group">
        <button
          className={`btn${preview ? ' on' : ''}`}
          disabled={!isMd}
          onClick={togglePreview}
          title="Markdown 分屏预览"
        >
          预览
        </button>
        <button
          className={`btn${side === 'outline' ? ' on' : ''}`}
          disabled={!isMd}
          onClick={() => toggleSide('outline')}
          title="Markdown 大纲"
        >
          大纲
        </button>
        <button
          className={`btn${side === 'backlinks' ? ' on' : ''}`}
          disabled={!active}
          onClick={() => toggleSide('backlinks')}
          title="双链与反向链接：谁引用了我，我引用了谁"
        >
          双链
        </button>
        <button
          className={`btn${side === 'tags' ? ' on' : ''}`}
          disabled={!active}
          onClick={() => toggleSide('tags')}
          title="标签：读写 front-matter 里的 tags"
        >
          标签
        </button>
        <button className={`btn${wrap ? ' on' : ''}`} onClick={toggleWrap} title="自动换行">
          换行
        </button>
        <button
          className="btn"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title="切换主题"
        >
          {theme === 'dark' ? '🌙' : '☀️'}
        </button>
      </div>

      <span className="toolbar-spacer" />

      <button className={`btn${pluginsOpen ? ' on' : ''}`} onClick={onTogglePlugins} title="WASM 插件">
        🧩 插件
      </button>
    </header>
  )
}
