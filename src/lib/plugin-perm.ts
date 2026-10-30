/**
 * 插件能力的展示名与安装提示。
 *
 * 键跟 `wit/plugin.wit` 的 `host` 接口一一对应，新增能力时这里和 Rust 侧
 * `plugin_perm.rs` 的 `KNOWN` 要一起改。漏了也不会崩：未知键原样显示。
 */
export interface PermissionMeta {
  key: string
  label: string
  hint: string
}

export const PERMISSIONS: PermissionMeta[] = [
  { key: 'log', label: '写日志', hint: '往宿主控制台打一行日志' },
  { key: 'now-ms', label: '读时钟', hint: '取当前毫秒时间戳' },
  { key: 'read-setting', label: '读设置', hint: '读 plugin-settings.json 里的键值' }
]

export function permMeta(key: string): PermissionMeta {
  return (
    PERMISSIONS.find(p => p.key === key) ?? {
      key,
      label: key,
      hint: '宿主不认识这个能力名，多半是拼错了'
    }
  )
}

export function permLabel(key: string): string {
  return permMeta(key).label
}

/** 「写日志 · 读设置」；空数组给「无」 */
export function permSummary(keys: string[] | null | undefined): string {
  if (!keys || !keys.length) return '无'
  return keys.map(permLabel).join(' · ')
}

/** 清单里写了但宿主不认识的能力名 */
export function unknownPerms(keys: string[] | null | undefined): string[] {
  if (!keys) return []
  return keys.filter(k => !PERMISSIONS.some(p => p.key === k))
}

/** 装完之后实际申请的能力里，比安装前答应的多出来的那些 */
export function extraPerms(
  actual: string[] | null | undefined,
  approved: string[] | null | undefined
): string[] {
  if (!actual) return []
  const okay = new Set(approved ?? [])
  return actual.filter(k => !okay.has(k))
}

/**
 * 安装确认框的正文：先说清要什么，再说清沙箱边界。
 * 不写「是否允许」那种假选项——装上就是允许，不允许就别装。
 */
export function installMessage(
  name: string,
  version: string,
  permissions: string[] | null | undefined
): string {
  const lines = permissions?.length
    ? permissions.map(k => `· ${permMeta(k).label}（${k}）`).join('\n')
    : '· 无，不调用任何宿主能力'
  return [
    `即将安装「${name}」v${version}。`,
    '',
    '它会申请这些宿主能力：',
    lines,
    '',
    '插件跑在 WASM 沙箱里，碰不到文件系统和网络；上面这些是它唯一能和外界打交道的口子。'
  ].join('\n')
}
