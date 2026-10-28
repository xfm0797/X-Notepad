/**
 * 搜索结果按目录分组。
 *
 * 搜索命中是按相关度排的（bm25），分组只做「同一个目录的排一起」，
 * 组之间的顺序沿用第一次出现的顺序——相关度高的目录自然排在前面，
 * 不用再拍一次脑袋定权重。
 */
import type { SearchHit } from './search'
import { isUnder, trimEnd } from './path'

export interface Group {
  /** 目录绝对路径，当折叠状态的 key */
  dir: string
  /** 相对工作区显示的短名 */
  label: string
  hits: SearchHit[]
  matches: number
}

/** 把文件所在目录折成「相对工作区」的名字，根目录显示成「根目录」 */
export function relativeDir(
  path: string,
  name: string,
  root: string | null
): { dir: string; label: string } {
  const dir = path.slice(0, Math.max(0, path.length - name.length)).replace(/[\\/]+$/, '')
  if (!root) return { dir, label: dir }
  const base = trimEnd(root)
  if (dir === base) return { dir, label: '根目录' }
  if (isUnder(dir, base)) {
    const rel = trimEnd(dir).slice(base.length).replace(/^[\\/]+/, '')
    return { dir, label: rel || '根目录' }
  }
  return { dir, label: dir }
}

export function groupHits(hits: SearchHit[], root: string | null): Group[] {
  const map = new Map<string, Group>()
  for (const hit of hits) {
    const { dir, label } = relativeDir(hit.path, hit.name, root)
    let group = map.get(dir)
    if (!group) {
      group = { dir, label, hits: [], matches: 0 }
      map.set(dir, group)
    }
    group.hits.push(hit)
    group.matches += hit.matches
  }
  return Array.from(map.values())
}
