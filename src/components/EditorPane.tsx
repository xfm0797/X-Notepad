import { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { indentWithTab } from '@codemirror/commands'
import { oneDark } from '@codemirror/theme-one-dark'
import { languageFor } from '../lib/lang'
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

  const makeState = (content: string) =>
    EditorState.create({
      doc: content,
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
    const view = new EditorView({ state: makeState(''), parent: host })
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
    view.setState(cached ?? makeState(doc?.content ?? ''))
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

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: wrapComp.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }, [wrap, wrapComp])

  if (doc?.binary) {
    return <div className="pane-empty">这是一份二进制文件，0.1.0 暂不支持预览与编辑。</div>
  }

  return <div className="editor-host" ref={hostRef} />
}
