/**
 * 插件市场的客户端逻辑。
 *
 * 索引是一个静态 JSON，放在仓库 market/index.json，通过 CDN 拿：
 * - jsDelivr 快，但会缓存 7 天，所以每次请求都带上 `_t` 时间戳
 * - GitHub raw / Gitee raw 作兜底（国内直连 Gitee 通常更稳）
 *
 * 桌面端所有请求都走 Rust 侧（`market_fetch`），WebView 里 fetch 会被 CORS 拦。
 */
import * as api from './api'

export interface MarketEntry {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  extensions?: string[]
  abi?: number
  /** 索引里标注的宿主能力，仅供安装前提示；真正生效的是包里 plugin.json 的声明 */
  permissions?: string[]
  /** 插件 zip 包地址 */
  url: string
  homepage?: string
}

export interface MarketIndex {
  version?: number
  plugins: MarketEntry[]
}

/** 默认源，按优先级排列 */
export const SOURCES = [
  'https://cdn.jsdelivr.net/gh/xfm0797/X-Notepad@main/market/index.json',
  'https://raw.githubusercontent.com/xfm0797/X-Notepad/main/market/index.json',
  'https://gitee.com/xfm0797/X-Notepad/raw/main/market/index.json'
]

const STORE_KEY = 'xnp:marketUrl'

export function customSource(): string {
  try {
    return localStorage.getItem(STORE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setCustomSource(url: string) {
  try {
    if (url.trim()) localStorage.setItem(STORE_KEY, url.trim())
    else localStorage.removeItem(STORE_KEY)
  } catch {
    /* ignore */
  }
}

/** jsDelivr 之类的 CDN 有强缓存，加个时间戳绕过去 */
function bust(url: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}_t=${Date.now()}`
}

/** 1.2.10 > 1.2.9；解析失败按 0 处理 */
export function compareVersion(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map(n => Number.parseInt(n, 10))
      .map(n => (Number.isFinite(n) ? n : 0))
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

export interface FetchResult {
  entries: MarketEntry[]
  /** 实际命中的源 */
  source: string
  failed: { url: string; error: string }[]
}

export async function fetchIndex(): Promise<FetchResult> {
  const custom = customSource()
  const list = custom ? [custom, ...SOURCES] : SOURCES
  const failed: { url: string; error: string }[] = []

  for (const url of list) {
    try {
      const text = await api.marketFetch(bust(url))
      const parsed = JSON.parse(text) as MarketIndex
      const entries = Array.isArray(parsed?.plugins) ? parsed.plugins : []
      // 过滤掉没有 id / url 的脏数据，剩下照用
      const clean = entries.filter(e => e && e.id && e.url && e.version)
      if (!clean.length) throw new Error('索引里没有有效插件')
      return { entries: clean, source: url, failed }
    } catch (e) {
      failed.push({ url, error: String(e).replace(/^Error:\s*/, '') })
    }
  }

  throw new Error(
    `所有源都不可用：\n${failed.map(f => `· ${f.url}\n  ${f.error}`).join('\n')}`
  )
}
