/**
 * 对话框状态：让 store 里的动作也能直接问用户。
 * 例如"关闭有未保存修改的标签页"需要三个选项（保存 / 不保存 / 取消）。
 */
import { create } from 'zustand'

export interface PromptOptions {
  title: string
  message?: string
  label?: string
  value?: string
  placeholder?: string
  confirmText?: string
  /** 返回错误文案则不关闭；返回 null 才提交 */
  validate?: (value: string) => string | null
}

export interface ConfirmOptions {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

export interface ChoiceOption {
  label: string
  value: string
  primary?: boolean
  danger?: boolean
}

export interface ChoiceOptions {
  title: string
  message: string
  options: ChoiceOption[]
}

type Request =
  | ({ kind: 'prompt'; resolve: (v: string | null) => void } & PromptOptions)
  | ({ kind: 'confirm'; resolve: (v: boolean) => void } & ConfirmOptions)
  | ({ kind: 'choice'; resolve: (v: string | null) => void } & ChoiceOptions)

interface DialogState {
  request: Request | null
  ask: (o: PromptOptions) => Promise<string | null>
  confirm: (o: ConfirmOptions) => Promise<boolean>
  choose: (o: ChoiceOptions) => Promise<string | null>
  settle: (value: string | null | boolean) => void
}

export const useDialogs = create<DialogState>()((set, get) => ({
  request: null,

  ask: o =>
    new Promise<string | null>(resolve => {
      set({ request: { kind: 'prompt', resolve, ...o } })
    }),

  confirm: o =>
    new Promise<boolean>(resolve => {
      set({ request: { kind: 'confirm', resolve, ...o } })
    }),

  choose: o =>
    new Promise<string | null>(resolve => {
      set({ request: { kind: 'choice', resolve, ...o } })
    }),

  settle: value => {
    const req = get().request
    if (!req) return
    set({ request: null })
    // 先清状态再 resolve：调用方拿到结果后往往会立刻弹下一个对话框
    if (req.kind === 'confirm') req.resolve(value === true)
    else req.resolve(typeof value === 'string' ? value : null)
  }
}))

export const ask = (o: PromptOptions) => useDialogs.getState().ask(o)
export const confirm = (o: ConfirmOptions) => useDialogs.getState().confirm(o)
export const choose = (o: ChoiceOptions) => useDialogs.getState().choose(o)
