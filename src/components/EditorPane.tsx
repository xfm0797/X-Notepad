import { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { indentWithTab } from '@codemirror/commands'
import { oneDark } from '@codemirror/theme-one-dark'
import { languageFor } from '../lib/lang'
import { cursorOf, rememberCursor } from '../lib/session'
import { useWorkspace } from '../store/workspace'

interface Props {
  path: string
}

/**
 * 一个 EditorView 服务所有标签页：
 * 每个标签的 EditorState（含撤销历史、选区、折叠状态）缓存在 Map 里，
 * 切换标签只是 setState，不用销毁重建 DOM。
 */
export function EditorPane({ path }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const statesRef = useRef(new Map<string, EditorState>())
  const prevPathRef = useRef<string | null>(null)
  const pathRef = useRef(path)

  const langComp = useRef(new Compartment()).current
  const themeComp = useRef(new Compartment()).current
  const wrapComp = useRef(new Compartment()).current

  const doc = useWorkspace(s => s.docs[path])
  const theme = useWorkspace(s => s.theme)
  const wrap = useWorkspace(s => s.wrap)

  // 回调放进 ref，避免重建 EditorState 时闭包过期
  const editRef = useRef(useWorkspace.getState().edit)
  const saveRef = useRef(useWorkspace.getState().save)
  const themeRef = useRef(theme)
  const wrapRef = useRef(wrap)
  editRef.current = useWorkspace(s => s.edit)
  saveRef.current = useWorkspace(s => s.save)
  themeRef.current = theme
  wrapRef.current = wrap
  pathRef.current = path

  const makeState = (content: string, forPath: string) =>
    EditorState.create({
      doc: content,
      // 光标位置从会话里捞回来；文档比上次短了就贴到末尾
      selection: { anchor: Math.min(cursorOf(forPath), content.length) },
      extensions: [
        basicSetup,
        keymap.of([
          indentWithTab,
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              void saveRef.current(pathRef.current)
              return true
            }
          }
        ]),
        themeComp.of(themeRef.current === 'dark' ? oneDark : []),
        wrapComp.of(wrapRef.current ? EditorView.lineWrapping : []),
        langComp.of([]),
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            editRef.current(pathRef.current, update.state.doc.toString())
          }
          if (update.selectionSet || update.docChanged) {
            rememberCursor(pathRef.current, update.state.selection.main.head)
          }
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13.5px' },
          '.cm-scroller': {
            fontFamily:
              'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
            lineHeight: '1.6'
          },
          '.cm-content': { padding: '10px 0' },
          '.cm-gutters': { border: 'none' }
        })
      ]
    })

  // 挂载视图
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({ state: makeState('', pathRef.current), parent: host })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
      statesRef.current.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换标签：先缓存旧 state，再换上新 state
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const prev = prevPathRef.current
    if (prev && prev !== path) statesRef.current.set(prev, view.state)

    const cached = statesRef.current.get(path)
    view.setState(cached ?? makeState(doc?.content ?? '', path))
    prevPathRef.current = path
    view.focus()

    // 语言包按需加载（language-data 的动态 import）
    const ext = path.split('.').pop() ?? ''
    const desc = languageFor(ext)
    if (desc) {
      void desc.load().then(support => {
        const v = viewRef.current
        if (v && pathRef.current === path) {
          v.dispatch({ effects: langComp.reconfigure(support) })
        }
      })
    } else {
      view.dispatch({ effects: langComp.reconfigure([]) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // 主题 / 换行实时生效
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: themeComp.reconfigure(theme === 'dark' ? oneDark : []) })
  }, [theme, themeComp])

  // 内容被整体替换（重新载入磁盘内容 / 恢复草稿）时同步进编辑器。
  // 用户自己打字时两边已经一致，这里不会有动作。
  const content = doc?.content
  useEffect(() => {
    const view = viewRef.current
    if (!view || content === undefined) return
    const current = view.state.doc.toString()
    if (current === content) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: content } })
    statesRef.current.set(path, view.state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, path])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: wrapComp.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }, [wrap, wrapComp])

  // 大纲 / 命令面板要求跳到某处
  const jump = useWorkspace(s => s.jump)
  useEffect(() => {
    const view = viewRef.current
    if (!view || !jump || jump.path !== path) return
    const pos = Math.min(Math.max(jump.pos, 0), view.state.doc.length)
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    view.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump])

  // 选中一个笔记后要往光标处插 `[[名字]]`（插入双链）
  const insert = useWorkspace(s => s.insert)
  useEffect(() => {
    const view = viewRef.current
    if (!view || !insert || insert.path !== path) return
    const at = view.state.selection.main
    view.dispatch({
      changes: { from: at.from, to: at.to, insert: insert.text },
      selection: { anchor: at.from + insert.text.length },
      scrollIntoView: true
    })
    view.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insert])

  if (doc?.binary) {
    return <div className="pane-empty">这是一份二进制文件，0.1.0 暂不支持预览与编辑。</div>
  }

  return <div className="editor-host" ref={hostRef} />
}
