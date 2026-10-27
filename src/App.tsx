import { useEffect, useState } from 'react'
import { Dialogs } from './components/Dialogs'
import { EditorPane } from './components/EditorPane'
import { ExternalBanner } from './components/ExternalBanner'
import { FileTree } from './components/FileTree'
import { PluginsPanel } from './components/PluginsPanel'
import { PreviewPane } from './components/PreviewPane'
import { StatusBar } from './components/StatusBar'
import { TabBar } from './components/TabBar'
import { Toolbar } from './components/Toolbar'
import { isTauri } from './lib/api'
import { isMarkdown } from './lib/lang'
import { onFsChange } from './lib/watch'
import { askNewEntry, useWorkspace } from './store/workspace'

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
          <kbd>Ctrl</kbd> + <kbd>N</kbd> 新建文件，<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>N</kbd> 新建文件夹
        </li>
        <li>文件树右键可以新建、重命名、删除</li>
        <li>Markdown 分屏预览，代码文件自动切到纯编辑器</li>
        <li>插件跑在 WebAssembly 沙箱里，默认拿不到文件系统</li>
      </ul>
      {!isTauri && <p className="welcome-note">当前是浏览器演示模式：文件读写走内存，WASM 插件不可用。</p>}
    </div>
  )
}

export default function App() {
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const active = useWorkspace(s => s.active)
  const doc = useWorkspace(s => (s.active ? s.docs[s.active] : undefined))
  const preview = useWorkspace(s => s.preview)
  const openFolder = useWorkspace(s => s.openFolder)

  // 全局快捷键：Ctrl+O 打开文件夹、Ctrl+Shift+S 保存全部、Ctrl+N / Ctrl+Shift+N 新建
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'o') {
        e.preventDefault()
        void openFolder()
      } else if (key === 's' && e.shiftKey) {
        e.preventDefault()
        void useWorkspace.getState().saveAll()
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

  // 崩溃恢复：上次没来得及保存的内容
  useEffect(() => {
    const t = setTimeout(() => void useWorkspace.getState().restoreDrafts(), 400)
    return () => clearTimeout(t)
  }, [])

  // 浏览器演示模式：自动挂上内存示例工作区，方便不装 Rust 也能看 UI
  useEffect(() => {
    if (isTauri) return
    const state = useWorkspace.getState()
    if (state.root) return
    void (async () => {
      await state.openFolder()
      await useWorkspace.getState().openFile('/demo/README.md')
    })()
  }, [])

  const ext = doc?.name.split('.').pop() ?? ''
  const showPreview = !!doc && preview && isMarkdown(ext)

  return (
    <div className="app">
      <Toolbar pluginsOpen={pluginsOpen} onTogglePlugins={() => setPluginsOpen(o => !o)} />
      <div className="main">
        <FileTree />
        <section className="editor-area">
          <TabBar />
          <ExternalBanner />
          {doc ? (
            <div className={`split${showPreview ? ' with-preview' : ''}`}>
              <EditorPane path={doc.path} />
              {showPreview && <PreviewPane content={doc.content} />}
            </div>
          ) : (
            <Welcome />
          )}
        </section>
      </div>
      <StatusBar />
      {pluginsOpen && <PluginsPanel onClose={() => setPluginsOpen(false)} />}
      <Dialogs />
    </div>
  )
}
