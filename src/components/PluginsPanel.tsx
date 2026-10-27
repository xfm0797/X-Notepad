import { useEffect, useState } from 'react'
import { isTauri, listPlugins, runPlugin, type PluginInfo } from '../lib/api'
import { useWorkspace } from '../store/workspace'

interface Props {
  onClose: () => void
}

export function PluginsPanel({ onClose }: Props) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState('')
  const [error, setError] = useState('')
  const active = useWorkspace(s => s.active)
  const doc = useWorkspace(s => (s.active ? s.docs[s.active] : undefined))

  useEffect(() => {
    void (async () => {
      const list = await listPlugins()
      setPlugins(list)
      if (isTauri && !list.length) {
        setError('还没有插件。把 plugin.json + plugin.wasm 放进用户数据目录的 plugins/ 下，或参考 plugins/csv-viewer 自行编译。')
      }
    })()
  }, [])

  const run = async (plugin: PluginInfo) => {
    if (!doc) return
    setRunning(plugin.id)
    setError('')
    setOutput('')
    try {
      const raw = await runPlugin(plugin.id, {
        action: 'render',
        path: doc.path,
        content: doc.content
      })
      setOutput(raw)
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setRunning('')
    }
  }

  return (
    <div className="panel-overlay" onClick={onClose}>
      <div className="panel" onClick={e => e.stopPropagation()}>
        <div className="panel-head">
          <b>插件</b>
          <span className="panel-sub">WASM 沙箱 · ABI v1</span>
          <span className="panel-spacer" />
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="panel-body">
          {!plugins.length && !error && <div className="pane-empty small">加载中…</div>}
          {plugins.map(p => (
            <div className="plugin-row" key={p.id}>
              <div>
                <div className="plugin-name">
                  {p.name} <span className="plugin-ver">v{p.version}</span>
                  {!p.available && <span className="plugin-warn">未编译</span>}
                </div>
                <div className="plugin-desc">{p.description ?? '（无描述）'}</div>
                <div className="plugin-meta">
                  {p.extensions.join(' / ') || '任意文件'} · ABI v{p.abi}
                  {p.author ? ` · ${p.author}` : ''}
                </div>
              </div>
              <button
                className="btn primary"
                disabled={!doc || !p.available || running === p.id}
                onClick={() => void run(p)}
                title={!doc ? '先在左侧打开一个文件' : '用当前文件内容运行'}
              >
                {running === p.id ? '运行中…' : '运行'}
              </button>
            </div>
          ))}

          {error && <div className="panel-error">{error}</div>}
          {output && (
            <div className="plugin-output">
              <div className="plugin-output-head">输出</div>
              <pre>{output}</pre>
            </div>
          )}
        </div>

        <div className="panel-foot">
          当前文件：{active ?? '未打开'}
        </div>
      </div>
    </div>
  )
}
