/**
 * 插件包签名的展示逻辑。
 *
 * 判定在 Rust 侧（`plugin_sig.rs`）做完了，这里只负责把四种状态翻译成
 * 用户看得懂的话，以及把用户贴进来的公钥规整成和后端一样的格式。
 *
 * 状态的含义：
 * - `verified`  签名有效：包里的内容确实出自这把私钥，且中途没被改
 * - `untrusted` 包上写了是谁签的，但那个 keyId 不在信任名单里，没法验
 * - `unsigned`  压根没签名
 * - `invalid`   签名不成立 / 内容和摘要对不上——这种包**装不上**，后端会直接拒
 */
import type { SignatureInfo, TrustedKey } from './api'

export type SigStatus = SignatureInfo['status']

const LABELS: Record<SigStatus, string> = {
  verified: '签名有效',
  untrusted: '密钥未信任',
  unsigned: '未签名',
  invalid: '签名无效'
}

const TONES: Record<SigStatus, 'ok' | 'warn' | 'bad' | 'muted'> = {
  verified: 'ok',
  untrusted: 'warn',
  unsigned: 'muted',
  invalid: 'bad'
}

export function sigLabel(status: SigStatus): string {
  return LABELS[status] ?? '未知'
}

export function sigTone(status: SigStatus): 'ok' | 'warn' | 'bad' | 'muted' {
  return TONES[status] ?? 'muted'
}

/** 装不上、只能重新下载的那种 */
export function sigFatal(status: SigStatus): boolean {
  return status === 'invalid'
}

/** 摘要只露前 12 位：够人对账，又不至于把整行撑爆 */
export function shortDigest(digest: string | null | undefined): string {
  const d = (digest ?? '').trim()
  return d.length > 12 ? `${d.slice(0, 12)}…` : d || '—'
}

/** 公钥指纹：前 8 位 … 后 8 位，跟 SSH 一个念法 */
export function keyFingerprint(publicKey: string): string {
  const k = (publicKey ?? '').trim().toLowerCase()
  if (k.length < 16) return k
  return `${k.slice(0, 8)}…${k.slice(-8)}`
}

/** 「签名有效 · XFM 官方」这种一句话 */
export function sigSummary(info: SignatureInfo | null | undefined): string {
  if (!info) return '未检查'
  const label = sigLabel(info.status)
  if (info.status === 'verified') return `${label} · ${info.keyLabel || info.keyId || '未知密钥'}`
  if (info.status === 'untrusted') return `${label} · ${info.keyId || '未知 keyId'}`
  return label
}

/** 鼠标悬停时的解释，直接把后端那句话带上 */
export function sigHint(info: SignatureInfo | null | undefined): string {
  if (!info) return ''
  const lines = [info.detail || sigLabel(info.status)]
  if (info.keyId) lines.push(`keyId：${info.keyId}`)
  lines.push(`内容摘要：${info.digest || '—'}`)
  return lines.join('\n')
}

/**
 * 装之前那段提示。签名有效就不啰嗦了；
 * 另外三种都要说清楚「这个包没法确认来源」，但只有 invalid 会被后端拒。
 */
export function sigNotice(info: SignatureInfo | null | undefined): string {
  if (!info || info.status === 'verified') return ''
  if (info.status === 'unsigned') {
    return '\n\n⚠ 这个包没有签名：能装，但无法确认是谁打的、中途有没有被改过。'
  }
  if (info.status === 'untrusted') {
    return `\n\n⚠ 包上写着由「${info.keyId ?? '未知'}」签名，但客户端不认识这把公钥，没法验证。\n想要验证，先在「签名密钥」里信任它，再重新看一眼。`
  }
  return `\n\n✗ 签名校验没通过：${info.detail}\n这个包装不上，请重新下载。`
}

/**
 * 公钥规整：去掉空格和冒号、转小写，必须正好 64 个十六进制字符。
 * 规则和 Rust 侧 `market.rs` 的 `normalize_pubkey` 保持一致。
 */
export function normalizePubkey(raw: string): { ok: boolean; key: string; error?: string } {
  const cleaned = (raw ?? '')
    .replace(/[\s:]/g, '')
    .toLowerCase()
  if (!cleaned) return { ok: false, key: '', error: '公钥不能为空' }
  if (!/^[0-9a-f]+$/.test(cleaned)) return { ok: false, key: cleaned, error: '只能有十六进制字符' }
  if (cleaned.length !== 64) {
    return { ok: false, key: cleaned, error: `应该是 64 个字符，现在是 ${cleaned.length} 个` }
  }
  return { ok: true, key: cleaned }
}

/** 这个 keyId 是不是已经在名单里了（用来决定要不要提示「去信任」） */
export function knownKey(keys: TrustedKey[] | null | undefined, id: string | null | undefined): TrustedKey | undefined {
  if (!keys || !id) return undefined
  const want = id.trim().toLowerCase()
  return keys.find(k => k.id.toLowerCase() === want)
}

/** 内置密钥删不掉：它们编译在客户端里，删了下次启动又会回来 */
export function removableKey(key: TrustedKey): boolean {
  return !key.builtin
}
