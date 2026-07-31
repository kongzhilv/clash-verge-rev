import type { Action, UnknownRecord } from './model'

export const BUILTIN_KEY = 'x-karing-diversion-builtins'

export const SIMPLE_ACTIONS = [
  ['none', '无（不使用）'],
  ['current', '当前选择'],
  ['auto-select', '自动选择'],
  ['direct', '直连'],
  ['reject', '拦截'],
] as const

export type SimpleAction = (typeof SIMPLE_ACTIONS)[number][0]

export interface BuiltinGroup {
  id: string
  presetId?: string
  name: string
  description?: string
  enabled: boolean
  action: SimpleAction
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
    description: '使用 GeoSite 广告分类直接拦截常见广告请求。',
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

const normalizeAction = (value: unknown): SimpleAction => {
  switch (value) {
    case 'none':
    case 'auto-select':
    case 'direct':
    case 'reject':
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
          rules,
        }
      })
    : []

  const existingPresetIds = new Set(
    normalized.map((group) => group.presetId).filter(Boolean),
  )

  return [
    ...normalized,
    ...PRESETS.filter(
      (preset) => !existingPresetIds.has(preset.presetId),
    ).map(clonePreset),
  ]
}

export const serializeBuiltinGroups = (groups: BuiltinGroup[]) =>
  groups.map((group) => ({
    id: group.id,
    name: group.name.trim(),
    enabled: group.enabled,
    logic: 'or',
    action: group.action,
    matchers: group.rules
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => ({
        enabled: true,
        type: 'RULE-SET-BUILDIN',
        value,
      })),
  }))

export const getBuiltinAction = (group: BuiltinGroup): SimpleAction =>
  group.enabled ? group.action : 'none'

export const withBuiltinAction = (
  group: BuiltinGroup,
  action: SimpleAction,
): BuiltinGroup => ({
  ...group,
  enabled: action !== 'none',
  action,
})

export const isSimpleAction = (action: Action): action is SimpleAction =>
  SIMPLE_ACTIONS.some(([value]) => value === action)
