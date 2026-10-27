/**
 * 外部修改提示条。
 *
 * 检测到磁盘文件被别的程序（或者同步盘）改过时不悄悄覆盖，
 * 而是让用户选：用磁盘的版本，还是坚持自己的。
 */
import { useWorkspace } from '../store/workspace'

export function ExternalBanner() {
  const doc = useWorkspace(s => (s.active ? s.docs[s.active] : undefined))
  const reloadFromDisk = useWorkspace(s => s.reloadFromDisk)
  const keepMine = useWorkspace(s => s.keepMine)

  if (!doc || (!doc.external && !doc.gone)) return null

  const dirty = doc.content !== doc.savedContent

  if (doc.gone) {
    return (
      <div className="banner danger">
        <span className="banner-text">
          <b>{doc.name}</b> 已被外部删除
          {dirty ? '，你的修改还在编辑器里。' : '。'}
        </span>
        <button className="btn small" onClick={() => void keepMine(doc.path)}>
          保留内容（保存时重建文件）
        </button>
      </div>
    )
  }

  return (
    <div className="banner warn">
      <span className="banner-text">
        <b>{doc.name}</b> 在磁盘上被其他程序修改了
        {dirty ? '，而你这里也有未保存的修改。' : '。'}
      </span>
      <button className="btn small" onClick={() => void reloadFromDisk(doc.path)}>
        重新载入
      </button>
      <button className="btn small" onClick={() => void keepMine(doc.path)}>
        {dirty ? '保留我的修改' : '忽略'}
      </button>
    </div>
  )
}
