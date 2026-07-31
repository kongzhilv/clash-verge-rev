import type { Action, UnknownRecord } from './model'

export const BUILTIN_KEY = 'x-karing-diversion-builtins'

export interface BuiltinGroup {
  id: string
  presetId?: string
  name: string
  description?: string
  enabled: boolean
  action: Action
  policy?: string
  rules: string[]
}

interface BuiltinPreset extends BuiltinGroup {
  presetId: string
}

const PRESETS: BuiltinPreset[] = [
  {
    id: 'builtin-cn-direct',
    presetId: 'cn-direct',
    name: '中国大陆直连',
    description: '中国大陆常见网站和 IP 直接连接，不经过代理。',
    enabled: false,
    action: 'direct',
    rules: ['geosite:cn', 'geoip:cn'],
  },
  {
    id: 'builtin-non-cn-proxy',
    presetId: 'non-cn-proxy',
    name: '境外网站代理',
    description: '常见非中国大陆网站交给主界面的“当前选择”。',
    enabled: false,
    action: 'current',
    rules: ['geosite:geolocation-!cn'],
  },
  {
    id: 'builtin-ads-reject',
    presetId: 'ads-reject',
    name: '广告拦截',
    description: '直接拦截常见广告请求。',
    enabled: false,
    action: 'reject',
    rules: ['geosite:category-ads-all'],
  },
  {
    id: 'builtin-ir-direct',
    presetId: 'ir-direct',
    name: '伊朗直连',
    description: '伊朗本地网站和 IP 直接连接，不经过代理。',
    enabled: false,
    action: 'direct',
    rules: ['geosite:ir', 'geoip:ir'],
  },
]

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizeAction = (value: unknown): Action => {
  switch (value) {
    case 'none':
    case 'current':
    case 'auto-select':
    case 'direct':
    case 'reject':
    case 'reject-drop':
    case 'policy':
      return value
    default:
      return 'current'
  }
}

const rulesSignature = (rules: string[]) =>
  rules
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('|')

const presetForRules = (rules: string[]) => {
  const signature = rulesSignature(rules)
  return PRESETS.find((preset) => rulesSignature(preset.rules) === signature)
}

const clonePreset = (preset: BuiltinPreset): BuiltinGroup => ({
  ...preset,
  rules: [...preset.rules],
})

export const normalizeBuiltinGroups = (value: unknown): BuiltinGroup[] => {
  const normalized = Array.isArray(value)
    ? value.filter(isRecord).map((group, index) => {
        const rules = Array.isArray(group.matchers)
          ? group.matchers
              .filter(isRecord)
              .map((matcher) =>
                typeof matcher.value === 'string' ? matcher.value.trim() : '',
              )
              .filter(Boolean)
          : []
        const preset = presetForRules(rules)

        return {
          id:
            typeof group.id === 'string' && group.id
              ? group.id
              : preset?.id || crypto.randomUUID(),
          presetId: preset?.presetId,
          name:
            typeof group.name === 'string' && group.name.trim()
              ? group.name
              : preset?.name || `内置规则组 ${index + 1}`,
          description: preset?.description,
          enabled: group.enabled !== false,
          action: normalizeAction(group.action),
          policy:
            typeof group.policy === 'string' ? group.policy.trim() : undefined,
          rules,
        }
      })
    : []

  const existingPresetIds = new Set(
    normalized.map((group) => group.presetId).filter(Boolean),
  )

  return [
    ...normalized,
    ...PRESETS.filter((preset) => !existingPresetIds.has(preset.presetId)).map(
      clonePreset,
    ),
  ]
}

export const serializeBuiltinGroups = (groups: BuiltinGroup[]) =>
  groups.map((group) => ({
    id: group.id,
    name: group.name.trim(),
    enabled: group.enabled,
    logic: 'or',
    action: group.action,
    ...(group.action === 'policy' && group.policy?.trim()
      ? { policy: group.policy.trim() }
      : {}),
    matchers: group.rules
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => ({
        enabled: true,
        type: 'RULE-SET-BUILDIN',
        value,
      })),
  }))

export const getBuiltinAction = (group: BuiltinGroup): Action =>
  group.enabled ? group.action : 'none'

export const withBuiltinAction = (
  group: BuiltinGroup,
  action: Action,
  policy?: string,
): BuiltinGroup => ({
  ...group,
  enabled: action !== 'none',
  action,
  policy: action === 'policy' ? policy : undefined,
})

export const validateBuiltinGroups = (groups: BuiltinGroup[]) => {
  for (const group of groups) {
    if (!group.enabled || group.action === 'none') continue
    if (group.action === 'policy' && !group.policy?.trim()) {
      return `规则组“${group.name}”还没有选择策略组或节点`
    }
    if (!group.rules.some((rule) => rule.trim())) {
      return `规则组“${group.name}”没有可用规则`
    }
  }
  return null
}
