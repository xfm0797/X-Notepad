import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  copyText,
  installPlugin,
  installPluginZip,
  isTauri,
  listPlugins,
  pickPluginZip,
  pluginDir,
  runPlugin,
  uninstallPlugin,
  type PluginInfo
} from '../lib/api'
import {
  compareVersion,
  customSource,
  fetchIndex,
  setCustomSource,
  type MarketEntry
} from '../lib/market'
import { confirm } from '../store/dialogs'
import { useWorkspace } from '../store/workspace'

interface Props {
  onClose: () => void
}

type Tab = 'installed' | 'market'

/** 源地址里最后一段，展示用 */
function sourceLabel(url: string): string {
  if (!url) return '未加载'
  if (url.includes('jsdelivr')) return 'jsDelivr'
  if (url.includes('gitee.com')) return 'Gitee'
  if (url.includes('raw.githubusercontent')) return 'GitHub raw'
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function PluginsPanel({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>('installed')
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [dir, setDir] = useState('')

  const [entries, setEntries] = useState<MarketEntry[]>([])
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(false)
  const [marketError, setMarketError] = useState('')

  const [query, setQuery] = useState('')
  const [sourceUrl, setSourceUrl] = useState(customSource())
  const [advanced, setAdvanced] = useState(false)

  const [busyId, setBusyId] = useState('')
  const [actionError, setActionError] = useState('')

  const [running, setRunning] = useState('')
  const [output, setOutput] = useState('')

  const doc = useWorkspace(s => (s.active ? s.docs[s.active] : undefined))
  const active = useWorkspace(s => s.active)

  const refreshPlugins = useCallback(async () => {
    const list = await listPlugins()
    setPlugins(list)
    setDir(await pluginDir())
  }, [])

  const loadMarket = useCallback(async () => {
    setLoading(true)
    setMarketError('')
    try {
      const res = await fetchIndex()
      setEntries(res.entries)
      setSource(res.source)
    } catch (e) {
      setMarketError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshPlugins()
  }, [refreshPlugins])

  const installedById = useMemo(() => {
    const map = new Map<string, PluginInfo>()
    for (const p of plugins) map.set(p.id, p)
    return map
  }, [plugins])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      e =>
        e.name.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q) ||
        (e.description ?? '').toLowerCase().includes(q)
    )
  }, [entries, query])

  const run = async (plugin: PluginInfo) => {
    if (!doc) return
    setRunning(plugin.id)
    setActionError('')
    setOutput('')
    try {
      const raw = await runPlugin(plugin.id, {
        action: 'render',
        path: doc.path,
        content: doc.content
      })
      setOutput(raw)
    } catch (e) {
      setActionError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setRunning('')
    }
  }

  const install = async (entry: MarketEntry) => {
    setBusyId(entry.id)
    setActionError('')
    try {
      const list = await installPlugin(entry.id, entry.url)
      setPlugins(list)
    } catch (e) {
      setActionError(`安装 ${entry.name} 失败：${String(e).replace(/^Error:\s*/, '')}`)
    } finally {
      setBusyId('')
    }
  }

  const uninstall = async (plugin: PluginInfo) => {
    const okay = await confirm({
      title: '卸载插件',
      message: `确定卸载「${plugin.name}」吗？\n${plugin.dir}`,
      confirmText: '卸载',
      danger: true
    })
    if (!okay) return
    setBusyId(plugin.id)
    setActionError('')
    try {
      setPlugins(await uninstallPlugin(plugin.id))
    } catch (e) {
      setActionError(`卸载失败：${String(e).replace(/^Error:\s*/, '')}`)
    } finally {
      setBusyId('')
    }
  }

  const installLocal = async () => {
    const path = await pickPluginZip()
    if (!path) return
    setBusyId('__local__')
    setActionError('')
    try {
      setPlugins(await installPluginZip(path))
    } catch (e) {
      setActionError(`安装失败：${String(e).replace(/^Error:\s*/, '')}`)
    } finally {
      setBusyId('')
    }
  }

  const renderInstalled = () => (
    <>
      {!plugins.length && (
        <div className="pane-empty small">
          {isTauri
            ? '还没有插件。去「插件市场」装一个，或者自己编译后把 zip 拖进来。'
            : '浏览器演示模式看不到真正的插件，桌面端才有 WASM 运行时。'}
        </div>
      )}

      {plugins.map(p => (
        <div className="plugin-row" key={p.id}>
          <div className="plugin-main">
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
          <div className="plugin-actions">
            <button
              className="btn primary"
              disabled={!doc || !p.available || running === p.id}
              onClick={() => void run(p)}
              title={!doc ? '先在左侧打开一个文件' : '用当前文件内容运行'}
            >
              {running === p.id ? '运行中…' : '运行'}
            </button>
            <button
              className="btn"
              disabled={busyId === p.id}
              onClick={() => void uninstall(p)}
            >
              卸载
            </button>
          </div>
        </div>
      ))}

      {output && (
        <div className="plugin-output">
          <div className="plugin-output-head">输出</div>
          <pre>{output}</pre>
        </div>
      )}
    </>
  )

  const renderMarket = () => (
    <>
      <div className="market-bar">
        <input
          className="text-input"
          placeholder="搜索插件"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <button className="btn" onClick={() => void loadMarket()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
        <button className="btn" onClick={() => void installLocal()} disabled={busyId === '__local__'}>
          本地安装
        </button>
      </div>

      <div className="market-source">
        <span>源：{sourceLabel(source)}</span>
        <button className="link-btn" onClick={() => setAdvanced(a => !a)}>
          {advanced ? '收起设置' : '换源'}
        </button>
      </div>

      {advanced && (
        <div className="market-advanced">
          <label className="dialog-label">自定义索引地址（留空则用内置的三个源）</label>
          <div className="market-bar">
            <input
              className="text-input"
              placeholder="https://…/index.json"
              value={sourceUrl}
              onChange={e => setSourceUrl(e.target.value)}
            />
            <button
              className="btn"
              onClick={() => {
                setCustomSource(sourceUrl)
                void loadMarket()
              }}
            >
              保存并刷新
            </button>
          </div>
        </div>
      )}

      {loading && !entries.length && <div className="pane-empty small">正在拉取插件列表…</div>}

      {!!entries.length && !filtered.length && <div className="pane-empty small">没有匹配的插件</div>}

      {filtered.map(entry => {
        const installed = installedById.get(entry.id)
        const newer = installed ? compareVersion(entry.version, installed.version) > 0 : false
        const label = !installed ? '安装' : newer ? '更新' : '重装'
        return (
          <div className="plugin-row" key={entry.id}>
            <div className="plugin-main">
              <div className="plugin-name">
                {entry.name} <span className="plugin-ver">v{entry.version}</span>
                {installed && !newer && (
                  <span className="plugin-badge">已安装 v{installed.version}</span>
                )}
                {installed && newer && (
                  <span className="plugin-badge update">已装 v{installed.version}</span>
                )}
              </div>
              <div className="plugin-desc">{entry.description ?? '（无描述）'}</div>
              <div className="plugin-meta">
                {(entry.extensions ?? []).join(' / ') || '任意文件'} · ABI v{entry.abi ?? 1}
                {entry.author ? ` · ${entry.author}` : ''}
              </div>
            </div>
            <div className="plugin-actions">
              <button
                className={`btn${newer || !installed ? ' primary' : ''}`}
                disabled={busyId === entry.id}
                onClick={() => void install(entry)}
              >
                {busyId === entry.id ? '处理中…' : label}
              </button>
            </div>
          </div>
        )
      })}

      {marketError && <div className="panel-error">{marketError}</div>}
    </>
  )

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

        <div className="panel-tabs">
          <button className={`tab-pill${tab === 'installed' ? ' on' : ''}`} onClick={() => setTab('installed')}>
            已安装 {plugins.length ? `(${plugins.length})` : ''}
          </button>
          <button
            className={`tab-pill${tab === 'market' ? ' on' : ''}`}
            onClick={() => {
              setTab('market')
              if (!entries.length && !loading) void loadMarket()
            }}
          >
            插件市场
          </button>
        </div>

        <div className="panel-body">
          {tab === 'installed' ? renderInstalled() : renderMarket()}
          {actionError && <div className="panel-error">{actionError}</div>}
        </div>

        <div className="panel-foot">
          {tab === 'installed' ? (
            <span title={dir}>
              插件目录：{dir || '—'} <button className="link-btn" onClick={() => void copyText(dir)}>复制</button>
            </span>
          ) : (
            <span>当前文件：{active ?? '未打开'}</span>
          )}
        </div>
      </div>
    </div>
  )
}
