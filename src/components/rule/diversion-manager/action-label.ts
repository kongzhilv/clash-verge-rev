import type { Action } from './model'

const ACTION_LABELS: Partial<Record<Action, string>> = {
  none: '无（不使用）',
  current: '当前选择',
  'auto-select': '自动选择',
  direct: '直连',
  reject: '拦截',
  'reject-drop': '静默拦截',
  policy: '指定策略组',
}

export const actionLabel = (action: Action, policy?: string) => {
  if (action === 'policy' && policy) return `指定策略：${policy}`
  return ACTION_LABELS[action] ?? action
}
