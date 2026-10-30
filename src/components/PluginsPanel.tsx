import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  copyText,
  installPlugin,
  installPluginZip,
  isTauri,
  listPlugins,
  peekPluginZip,
  pickPluginZip,
  pluginDir,
  runPlugin,
  uninstallPlugin,
  type PluginInfo,
  type PluginPeek
} from '../lib/api'
import {
  compareVersion,
  customSource,
  fetchIndex,
  setCustomSource,
  type MarketEntry
} from '../lib/market'
import { extraPerms, installMessage, permLabel, permMeta, unknownPerms } from '../lib/plugin-perm'
import { confirm } from '../store/dialogs'
import { useWorkspace } from '../store/workspace'

interface Props {
  onClose: () => void
}

type Tab = 'installed' | 'market'

/** ABI 版本怎么念给用户听：v2 是组件，v1 是老的指针协议 */
function abiLabel(abi: number): string {
  return abi >= 2 ? 'ABI v2 · 组件' : 'ABI v1'
}

/** 一行能力标签：没申请就写「无」，认不出的键单独标出来 */
function PermChips({ keys, unknown }: { keys?: string[] | null; unknown?: string[] | null }) {
  const list = keys ?? []
  const bad = unknown ?? []
  return (
    <div className="plugin-perms">
      权限：
      {list.length ? (
        list.map(k => (
          <span className="perm-chip" key={k} title={permMeta(k).hint}>
            {permLabel(k)}
          </span>
        ))
      ) : (
        <span className="perm-none">无</span>
      )}
      {bad.map(k => (
        <span className="perm-chip unknown" key={`u-${k}`} title="宿主不认识这个能力名，多半是拼错了">
          {k} ?
        </span>
      ))}
    </div>
  )
}

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
  /** 不算错误、但用户该知道的事（比如实际权限比索引里写得多） */
  const [notice, setNotice] = useState('')

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
    const okay = await confirm({
      title: '安装插件',
      message: installMessage(entry.name, entry.version, entry.permissions),
      confirmText: '安装'
    })
    if (!okay) return

    setBusyId(entry.id)
    setActionError('')
    setNotice('')
    try {
      const list = await installPlugin(entry.id, entry.url)
      setPlugins(list)
      // 索引是给人看的，豁免不了包里自己的清单：实际申请多了就说一声
      const extra = extraPerms(
        list.find(p => p.id === entry.id)?.permissions,
        entry.permissions
      )
      if (extra.length) {
        setNotice(
          `已安装，但包里实际申请的能力比索引里写得多：${extra.map(permLabel).join(' / ')}。` +
            '可以在「已安装」里核对这些权限，不满意就卸载。'
        )
      }
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
    setActionError('')
    setNotice('')

    // 先读包里的清单：装之前就把权限摆出来，别等装完才让人事后诸葛亮
    let peek: PluginPeek
    try {
      peek = await peekPluginZip(path)
    } catch (e) {
      setActionError(`读取插件包失败：${String(e).replace(/^Error:\s*/, '')}`)
      return
    }

    const tail = peek.hasEntry ? '' : '\n\n注意：包里没有清单指向的 wasm，装上也不能运行。'
    const okay = await confirm({
      title: '安装插件',
      message: installMessage(peek.name, peek.version, peek.permissions) + tail,
      confirmText: '安装'
    })
    if (!okay) return

    setBusyId('__local__')
    try {
      const list = await installPluginZip(path)
      setPlugins(list)
      const extra = extraPerms(
        list.find(p => p.id === peek.id)?.permissions,
        peek.permissions
      )
      if (extra.length) {
        setNotice(`已安装，但实际申请的能力比清单里多一些：${extra.map(permLabel).join(' / ')}。`)
      }
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
              {p.extensions.join(' / ') || '任意文件'} · {abiLabel(p.abi)}
              {p.author ? ` · ${p.author}` : ''}
            </div>
            <PermChips keys={p.permissions} unknown={p.unknownPermissions} />
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
                {(entry.extensions ?? []).join(' / ') || '任意文件'} · {abiLabel(entry.abi ?? 1)}
                {entry.author ? ` · ${entry.author}` : ''}
              </div>
              {entry.permissions ? (
                <PermChips keys={entry.permissions} unknown={unknownPerms(entry.permissions)} />
              ) : (
                <div className="plugin-perms">
                  权限：<span className="perm-none">索引未标注，装之前会再确认一次</span>
                </div>
              )}
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
          <span className="panel-sub">WASM 沙箱 · ABI v1 / v2 · 能力按清单授予</span>
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
          {notice && <div className="panel-note">{notice}</div>}
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
