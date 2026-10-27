import { languageLabel } from '../lib/lang'
import { useWorkspace } from '../store/workspace'

export function StatusBar() {
  const active = useWorkspace(s => s.active)
  const doc = useWorkspace(s => (s.active ? s.docs[s.active] : undefined))
  const message = useWorkspace(s => s.message)

  const ext = doc?.name.split('.').pop() ?? ''
  const lines = doc ? doc.content.split('\n').length : 0
  const chars = doc ? doc.content.length : 0
  const dirty = doc ? doc.content !== doc.savedContent : false

  return (
    <footer className="statusbar">
      <span className="status-item">{message || (doc ? doc.path : '就绪')}</span>
      <span className="status-spacer" />
      {doc && (
        <>
          <span className="status-item">{dirty ? '未保存' : '已保存'}</span>
          <span className="status-item">{languageLabel(ext)}</span>
          <span className="status-item">{doc.encoding}</span>
          <span className="status-item">{doc.eol}</span>
          <span className="status-item">
            {lines} 行 · {chars} 字符
          </span>
        </>
      )}
    </footer>
  )
}
