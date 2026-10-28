import { useEffect, useState } from 'react'
import { CommandPalette } from './components/CommandPalette'
import { Dialogs } from './components/Dialogs'
import { EditorPane } from './components/EditorPane'
import { ExternalBanner } from './components/ExternalBanner'
import { FileTree } from './components/FileTree'
import { LinkPicker } from './components/LinkPicker'
import { PluginsPanel } from './components/PluginsPanel'
import { PreviewPane } from './components/PreviewPane'
import { SearchPanel } from './components/SearchPanel'
import { SidePanel } from './components/SidePanel'
import { StatusBar } from './components/StatusBar'
import { TabBar } from './components/TabBar'
import { Toolbar } from './components/Toolbar'
import { isTauri } from './lib/api'
import { isMarkdown } from './lib/lang'
import * as session from './lib/session'
import { onFsChange } from './lib/watch'
import { currentLabel, initialTarget, openNewWindow } from './lib/window'
import { askNewEntry, useWorkspace } from './store/workspace'

const DEMO_ENTRY = '/demo/README.md'

function Welcome() {
  const openFolder = useWorkspace(s => s.openFolder)
  return (
    <div className="welcome">
      <h1>X-Notepad</h1>
      <p className="welcome-sub">笔记与代码，一个窗口。</p>
      <button className="btn primary big" onClick={() => void openFolder()}>
        打开文件夹
      </button>
      <ul className="welcome-tips">
        <li>
          <kbd>Ctrl</kbd> + <kbd>S</kbd> 保存，松手 1.2 秒也会自动保存
        </li>
        <li>
          <kbd>Ctrl</kbd> + <kbd>P</kbd> 命令面板，输入文件名可以直接跳过去
        </li>
        <li>
          <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>F</kbd> 全文搜索：结果按目录分组，点 <b>.*</b> 切正则
        </li>
        <li>
          <kbd>Ctrl</kbd> + <kbd>N</kbd> 新建文件，<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>N</kbd> 新建文件夹
        </li>
        <li>
          <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>N</kbd> 新开窗口，两个窗口可以盯两个文件夹
        </li>
        <li>
          <b>[[想法]]</b> 写双链，工具栏「双链」看谁引用了我；「标签」读写 front-matter 里的 tags
        </li>
        <li>
          <b>[[想法]]</b> 写双链，工具栏「双链」看谁引用了我；「标签」读写 front-matter 里的 tags
        </li>
        <li>文件树右键可以新建、重命名、删除；关了软件下次还回到这一页</li>
        <li>Markdown 分屏预览 + 大纲，代码文件自动切到纯编辑器</li>
      </ul>
      {!isTauri && <p className="welcome-note">当前是浏览器演示模式：文件读写走内存，WASM 插件不可用。</p>}
    </div>
  )
}

export default function App() {
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const doc = useWorkspace(s => (s.active ? s.docs[s.active] : undefined))
  const preview = useWorkspace(s => s.preview)
  const side = useWorkspace(s => s.side)
  const linkPickerOpen = useWorkspace(s => s.linkPickerOpen)
  const searchOpen = useWorkspace(s => s.searchOpen)
  const openFolder = useWorkspace(s => s.openFolder)

  // 全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'f' && e.shiftKey) {
        // Ctrl+Shift+F：全文搜索（Ctrl+F 留给编辑器的查找）
        e.preventDefault()
        useWorkspace.getState().toggleSearch()
      } else if (key === 'p') {
        // Ctrl+P / Ctrl+Shift+P 都开命令面板
        e.preventDefault()
        setPaletteOpen(true)
      } else if (key === 'o') {
        e.preventDefault()
        void openFolder()
      } else if (key === 'w') {
        const cur = useWorkspace.getState().active
        if (!cur) return
        e.preventDefault()
        void useWorkspace.getState().closeTab(cur)
      } else if (key === 's' && e.shiftKey) {
        e.preventDefault()
        void useWorkspace.getState().saveAll()
      } else if (key === 'n' && e.altKey) {
        // Ctrl+Alt+N：新开一个窗口（Ctrl+N 留给新建文件）
        e.preventDefault()
        void openNewWindow({ root: useWorkspace.getState().root })
      } else if (key === 'n') {
        const root = useWorkspace.getState().root
        if (!root) return
        e.preventDefault()
        void askNewEntry(root, e.shiftKey ? 'dir' : 'file')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openFolder])

  // 文件监听：事件可能几十毫秒内连着来一串，攒 300ms 再统一处理
  useEffect(() => {
    let dispose: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending: string[] = []
    let disposed = false

    void (async () => {
      const off = await onFsChange(change => {
        pending.push(...change.paths)
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          const paths = Array.from(new Set(pending))
          pending = []
          void useWorkspace.getState().handleFsChange(paths)
        }, 300)
      })
      if (disposed) off()
      else dispose = off
    })()

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      dispose?.()
    }
  }, [])

  // 启动：先恢复会话（上次的文件夹和标签），再问要不要捡回未保存的草稿
  useEffect(() => {
    void (async () => {
      // 会话按窗口分仓：主窗口沿用老 key，新窗口各记各的
      session.useSessionScope(currentLabel())

      const state = useWorkspace.getState()
      const target = initialTarget()
      if (target.root) {
        // 从别的窗口带参数过来的：直接进那个工作区，不读本窗口的旧会话
        await state.openWorkspaceAt(target.root, target.file)
      } else {
        await state.restoreSession()
      }
      // 浏览器演示模式：没有会话就挂上内存示例工作区，不装 Rust 也能看 UI
      if (!isTauri && !useWorkspace.getState().root) {
        await state.openFolder()
        await useWorkspace.getState().openFile(DEMO_ENTRY)
      }
      await useWorkspace.getState().restoreDrafts()
    })()
  }, [])

  // 会话持久化：任何状态变化都攒 400ms 落一次盘
  useEffect(() => {
    const unsub = useWorkspace.subscribe(s => {
      if (!s.root) return
      session.rememberSession({
        root: s.root,
        tabs: s.tabs,
        active: s.active,
        preview: s.preview,
        wrap: s.wrap,
        side: s.side
      })
    })
    const flush = () => session.flushSession()
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      unsub()
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [])

  const ext = doc?.name.split('.').pop() ?? ''
  const showPreview = !!doc && preview && isMarkdown(ext)
  const showSide = !!doc && side !== 'none'

  return (
    <div className="app">
      <Toolbar
        pluginsOpen={pluginsOpen}
        onTogglePlugins={() => setPluginsOpen(o => !o)}
        onOpenPalette={() => setPaletteOpen(true)}
        onNewWindow={() => void openNewWindow({ root: useWorkspace.getState().root })}
      />
      <div className="main">
        <FileTree />
        <section className="editor-area">
          <TabBar />
          <ExternalBanner />
          {doc ? (
            <div className={`split${showPreview ? ' with-preview' : ''}${showSide ? ' with-side' : ''}`}>
              {showSide && <SidePanel path={doc.path} content={doc.content} />}
              <EditorPane path={doc.path} />
              {showPreview && <PreviewPane path={doc.path} content={doc.content} />}
            </div>
          ) : (
            <Welcome />
          )}
        </section>
      </div>
      <StatusBar />
      {searchOpen && <SearchPanel />}
      {linkPickerOpen && <LinkPicker />}
      {pluginsOpen && <PluginsPanel onClose={() => setPluginsOpen(false)} />}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onOpenPlugins={() => {
            setPaletteOpen(false)
            setPluginsOpen(true)
          }}
        />
      )}
      <Dialogs />
    </div>
  )
}
