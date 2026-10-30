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
  pluginKeyAdd,
  pluginKeyRemove,
  pluginKeys,
  runPlugin,
  uninstallPlugin,
  type PluginInfo,
  type PluginPeek,
  type SignatureInfo,
  type TrustedKey
} from '../lib/api'
import {
  compareVersion,
  customSource,
  fetchIndex,
  setCustomSource,
  type MarketEntry
} from '../lib/market'
import { extraPerms, installMessage, permLabel, permMeta, unknownPerms } from '../lib/plugin-perm'
import {
  keyFingerprint,
  normalizePubkey,
  removableKey,
  sigFatal,
  sigHint,
  sigNotice,
  sigSummary,
  sigTone
} from '../lib/plugin-sig'
import { confirm } from '../store/dialogs'
import { useWorkspace } from '../store/workspace'

interface Props {
  onClose: () => void
}

type Tab = 'installed' | 'market' | 'keys'

/** ABI 版本怎么念给用户听：v2 是组件，v1 是老的指针协议 */
function abiLabel(abi: number): string {
  return abi >= 2 ? 'ABI v2 · 组件' : 'ABI v1'
}

/** 签名状态小标签：颜色随状态变，悬停给出 keyId 与摘要 */
function SigChip({ info }: { info: SignatureInfo | null | undefined }) {
  if (!info) return null
  return (
    <span className={`sig-chip ${sigTone(info.status)}`} title={sigHint(info)}>
      {sigSummary(info)}
    </span>
  )
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

  const [keys, setKeys] = useState<TrustedKey[]>([])
  const [newKeyId, setNewKeyId] = useState('')
  const [newKeyPub, setNewKeyPub] = useState('')
  const [newKeyLabel, setNewKeyLabel] = useState('')
  const [keyError, setKeyError] = useState('')

  const doc = useWorkspace(s => (s.active ? s.docs[s.active] : undefined))
  const active = useWorkspace(s => s.active)

  const refreshPlugins = useCallback(async () => {
    const list = await listPlugins()
    setPlugins(list)
    setDir(await pluginDir())
  }, [])

  const refreshKeys = useCallback(async () => {
    setKeys(await pluginKeys())
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
    void refreshKeys()
  }, [refreshPlugins, refreshKeys])

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

  /** 装完之后关于签名的补充说明：签名有效就不说了 */
  const sigNoteAfterInstall = (info?: SignatureInfo | null): string => {
    if (!info || info.status === 'verified') return ''
    if (info.status === 'unsigned') return '这个包没有签名，来源没法核实。'
    return `这个包由「${info.keyId ?? '未知'}」签名，但这把公钥不在信任名单里——去「签名密钥」里加上才能验证。`
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
      const just = list.find(p => p.id === entry.id)
      // 索引是给人看的，豁免不了包里自己的清单：实际申请多了就说一声
      const extra = extraPerms(just?.permissions, entry.permissions)
      const notes: string[] = []
      if (extra.length) {
        notes.push(
          `已安装，但包里实际申请的能力比索引里写得多：${extra.map(permLabel).join(' / ')}。` +
            '可以在「已安装」里核对这些权限，不满意就卸载。'
        )
      }
      const sigNote = sigNoteAfterInstall(just?.signature)
      if (sigNote) notes.push(sigNote)
      setNotice(notes.join('\n'))
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
    if (sigFatal(peek.signature.status)) {
      // 后端也会拒，这里先一步把话说清楚，省得用户点完才看到报错
      setActionError(`签名校验没通过，已拒绝安装：${peek.signature.detail}`)
      return
    }
    const okay = await confirm({
      title: '安装插件',
      message:
        installMessage(peek.name, peek.version, peek.permissions) +
        sigNotice(peek.signature) +
        tail,
      confirmText: '安装'
    })
    if (!okay) return

    setBusyId('__local__')
    try {
      const list = await installPluginZip(path)
      setPlugins(list)
      const just = list.find(p => p.id === peek.id)
      const extra = extraPerms(just?.permissions, peek.permissions)
      const notes: string[] = []
      if (extra.length) {
        notes.push(`已安装，但实际申请的能力比清单里多一些：${extra.map(permLabel).join(' / ')}。`)
      }
      const sigNote = sigNoteAfterInstall(just?.signature ?? peek.signature)
      if (sigNote) notes.push(sigNote)
      setNotice(notes.join('\n'))
    } catch (e) {
      setActionError(`安装失败：${String(e).replace(/^Error:\s*/, '')}`)
    } finally {
      setBusyId('')
    }
  }

  const addKey = async () => {
    setKeyError('')
    const id = newKeyId.trim()
    if (!id) {
      setKeyError('密钥 id 不能为空，写什么由你定，只要和包里 signature.json 的 keyId 对上')
      return
    }
    const pub = normalizePubkey(newKeyPub)
    if (!pub.ok) {
      setKeyError(`公钥不对：${pub.error}`)
      return
    }
    try {
      setKeys(await pluginKeyAdd(id, pub.key, newKeyLabel.trim() || id))
      setNewKeyId('')
      setNewKeyPub('')
      setNewKeyLabel('')
      setNotice(`已信任密钥「${id}」。重新打开插件包的确认框就能看到验签结果。`)
    } catch (e) {
      setKeyError(String(e).replace(/^Error:\s*/, ''))
    }
  }

  const removeKey = async (key: TrustedKey) => {
    const okay = await confirm({
      title: '移除签名密钥',
      message: `移除之后，由「${key.label || key.id}」签名的包会退回「密钥未信任」——能装，但验不了签。`,
      confirmText: '移除',
      danger: true
    })
    if (!okay) return
    setKeyError('')
    try {
      setKeys(await pluginKeyRemove(key.id))
    } catch (e) {
      setKeyError(String(e).replace(/^Error:\s*/, ''))
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
            <div className="plugin-sig-row">
              <SigChip info={p.signature} />
              {p.signature?.status !== 'verified' && (
                <span className="sig-hint">{p.signature?.detail}</span>
              )}
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

  const renderKeys = () => (
    <>
      <div className="pane-empty small">
        插件包用 Ed25519 签名：作者私钥自留、公钥公开，你把公钥贴进来即可。装包时客户端拿公钥验一遍，
        内容对不上直接拒绝安装；没签名或不认识的密钥只是提醒。官方密钥编译在客户端里，删不掉。
      </div>

      {!keys.length && <div className="pane-empty small">还没有信任任何密钥。</div>}

      {keys.map(k => (
        <div className="plugin-row" key={k.id}>
          <div className="plugin-main">
            <div className="plugin-name">
              {k.label || k.id}
              {k.builtin && <span className="plugin-badge">内置</span>}
            </div>
            <div className="plugin-meta">
              keyId：{k.id} · 指纹 <span className="mono">{keyFingerprint(k.publicKey)}</span>
            </div>
          </div>
          <div className="plugin-actions">
            {removableKey(k) ? (
              <button className="btn" onClick={() => void removeKey(k)}>
                移除
              </button>
            ) : (
              <span className="perm-none">随客户端发布</span>
            )}
          </div>
        </div>
      ))}

      <div className="key-form">
        <label className="dialog-label">信任一把新公钥</label>
        <div className="market-bar">
          <input
            className="text-input"
            placeholder="keyId（要和包里 signature.json 的一致）"
            value={newKeyId}
            onChange={e => setNewKeyId(e.target.value)}
          />
          <input
            className="text-input"
            placeholder="备注名（可选）"
            value={newKeyLabel}
            onChange={e => setNewKeyLabel(e.target.value)}
          />
        </div>
        <input
          className="text-input mono"
          placeholder="公钥：64 个十六进制字符，空格和冒号会自动去掉"
          value={newKeyPub}
          onChange={e => setNewKeyPub(e.target.value)}
        />
        <div className="market-bar">
          <button className="btn primary" onClick={() => void addKey()}>
            添加
          </button>
          <span className="sig-hint">私钥不要贴进来；这里只收公钥。</span>
        </div>
      </div>

      {keyError && <div className="panel-error">{keyError}</div>}
    </>
  )

  return (
    <div className="panel-overlay" onClick={onClose}>
      <div className="panel" onClick={e => e.stopPropagation()}>
        <div className="panel-head">
          <b>插件</b>
          <span className="panel-sub">WASM 沙箱 · ABI v1 / v2 · 能力按清单授予 · 安装前验签</span>
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
          <button
            className={`tab-pill${tab === 'keys' ? ' on' : ''}`}
            onClick={() => {
              setTab('keys')
              void refreshKeys()
            }}
          >
            签名密钥 {keys.length ? `(${keys.length})` : ''}
          </button>
        </div>

        <div className="panel-body">
          {tab === 'installed' ? renderInstalled() : tab === 'market' ? renderMarket() : renderKeys()}
          {notice && <div className="panel-note">{notice}</div>}
          {actionError && <div className="panel-error">{actionError}</div>}
        </div>

        <div className="panel-foot">
          {tab === 'installed' ? (
            <span title={dir}>
              插件目录：{dir || '—'} <button className="link-btn" onClick={() => void copyText(dir)}>复制</button>
            </span>
          ) : tab === 'keys' ? (
            <span>密钥存在本地，随卸载重装丢失；官方密钥随客户端发布。</span>
          ) : (
            <span>当前文件：{active ?? '未打开'}</span>
          )}
        </div>
      </div>
    </div>
  )
}
