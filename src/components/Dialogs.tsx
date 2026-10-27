/**
 * 通用对话框 UI：输入框（新建 / 重命名）、二次确认、多选一。
 * 状态在 store/dialogs.ts，这里只负责画。
 */
import { useEffect, useRef, useState } from 'react'
import { useDialogs } from '../store/dialogs'

export function Dialogs() {
  const request = useDialogs(s => s.request)
  const settle = useDialogs(s => s.settle)
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const cancel = () => settle(request?.kind === 'confirm' ? false : null)

  // 每次换对话框都要重置输入与错误
  useEffect(() => {
    if (!request) return
    setValue(request.kind === 'prompt' ? (request.value ?? '') : '')
    setError('')
    if (request.kind === 'prompt') {
      // 打开时全选，改名场景可以直接覆盖输入
      window.setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [request])

  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        settle(request.kind === 'confirm' ? false : null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [request, settle])

  if (!request) return null

  const submitPrompt = () => {
    if (request.kind !== 'prompt') return
    const err = request.validate?.(value) ?? null
    if (err) {
      setError(err)
      return
    }
    settle(value.trim())
  }

  return (
    <div className="panel-overlay dialog-overlay" onMouseDown={cancel}>
      <div className="dialog" onMouseDown={e => e.stopPropagation()}>
        <div className="dialog-head">
          <b>{request.title}</b>
          <span className="panel-spacer" />
          <button className="icon-btn" onClick={cancel} title="关闭">
            ×
          </button>
        </div>

        <div className="dialog-body">
          {request.kind === 'prompt' ? (
            <>
              {request.message && <p className="dialog-message">{request.message}</p>}
              {request.label && <label className="dialog-label">{request.label}</label>}
              <input
                ref={inputRef}
                className="text-input"
                value={value}
                placeholder={request.placeholder}
                autoFocus
                onChange={e => {
                  setValue(e.target.value)
                  setError('')
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitPrompt()
                  }
                }}
              />
              {error && <div className="dialog-error">{error}</div>}
            </>
          ) : (
            <p className="dialog-message">{request.message}</p>
          )}
        </div>

        <div className="dialog-foot">
          {request.kind === 'choice' ? (
            <>
              <button className="btn" onClick={() => settle(null)}>
                取消
              </button>
              <span className="panel-spacer" />
              {request.options.map(opt => (
                <button
                  key={opt.value}
                  className={`btn${opt.primary ? ' primary' : ''}${opt.danger ? ' danger' : ''}`}
                  onClick={() => settle(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </>
          ) : (
            <>
              <span className="panel-spacer" />
              <button className="btn" onClick={cancel}>
                {request.kind === 'confirm' ? (request.cancelText ?? '取消') : '取消'}
              </button>
              <button
                className={`btn primary${request.kind === 'confirm' && request.danger ? ' danger' : ''}`}
                onClick={() => (request.kind === 'confirm' ? settle(true) : submitPrompt())}
              >
                {request.confirmText ?? (request.kind === 'confirm' ? '确定' : '创建')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
