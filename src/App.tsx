import { useEffect, useState } from 'react'
import { EditorPane } from './components/EditorPane'
import { FileTree } from './components/FileTree'
import { PluginsPanel } from './components/PluginsPanel'
import { PreviewPane } from './components/PreviewPane'
import { StatusBar } from './components/StatusBar'
import { TabBar } from './components/TabBar'
import { Toolbar } from './components/Toolbar'
import { isMarkdown } from './lib/lang'
import { isTauri } from './lib/api'
import { useWorkspace } from './store/workspace'

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
          <kbd>Ctrl</kbd> + <kbd>F</kbd> 在当前文件里查找替换
        </li>
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

  // 全局快捷键：Ctrl+O 打开文件夹、Ctrl+Shift+S 保存全部
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      if (e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openFolder()
      } else if (e.key.toLowerCase() === 's' && e.shiftKey) {
        e.preventDefault()
        void useWorkspace.getState().saveAll()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openFolder])

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
    </div>
  )
}
