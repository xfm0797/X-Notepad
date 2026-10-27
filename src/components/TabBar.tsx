import { useWorkspace } from '../store/workspace'

export function TabBar() {
  const tabs = useWorkspace(s => s.tabs)
  const active = useWorkspace(s => s.active)
  const docs = useWorkspace(s => s.docs)
  const activate = useWorkspace(s => s.activate)
  const closeTab = useWorkspace(s => s.closeTab)

  if (!tabs.length) return null

  return (
    <div className="tabbar">
      {tabs.map(path => {
        const doc = docs[path]
        const dirty = doc ? doc.content !== doc.savedContent : false
        return (
          <div
            key={path}
            className={`tab${active === path ? ' active' : ''}`}
            onClick={() => activate(path)}
            title={path}
          >
            <span className="tab-name">{doc?.name ?? path}</span>
            <button
              className="tab-close"
              title="关闭"
              onClick={e => {
                e.stopPropagation()
                void closeTab(path)
              }}
            >
              {dirty ? '●' : '×'}
            </button>
          </div>
        )
      })}
    </div>
  )
}
