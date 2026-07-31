export const CONFIG_KEY = 'x-karing-diversion'

export const MATCHER_TYPES = [
  ['DOMAIN-SUFFIX', '域名后缀'],
  ['DOMAIN', '完整域名'],
  ['DOMAIN-KEYWORD', '域名关键词'],
  ['DOMAIN-REGEX', '域名正则'],
  ['IP-CIDR', 'IP CIDR'],
  ['DST-PORT', '目标端口'],
  ['NETWORK', '协议'],
  ['GEOSITE', 'GeoSite'],
  ['GEOIP', 'GeoIP'],
  ['RULE-SET', 'Rule Set'],
  ['RULE-SET-BUILDIN', 'Rule Set(build-in)'],
  ['PROCESS-NAME', '进程名称'],
  ['PROCESS-PATH', '进程路径'],
] as const

export const ACTIONS = [
  ['none', '无'],
  ['current', '当前选择'],
  ['auto-select', '自动选择'],
  ['direct', '直连'],
  ['reject', '拦截'],
  ['reject-drop', '静默拦截'],
  ['policy', '指定策略组'],
] as const

export type Action = (typeof ACTIONS)[number][0]
export type MatcherType = (typeof MATCHER_TYPES)[number][0]
export type UnknownRecord = Record<string, unknown>
export type DiversionUiMode = 'simple' | 'advanced'
export type DiversionRegion = '' | 'cn' | 'ir'

const createUiId = () => crypto.randomUUID()

export interface DiversionMatcher {
  id: string
  enabled: boolean
  type: MatcherType
  value: string
  'no-resolve'?: boolean
  provider?: string
  url?: string
  behavior?: 'domain' | 'ipcidr' | 'classical'
  format?: 'yaml' | 'text' | 'mrs'
  interval?: number
}

export interface DiversionGroup {
  id: string
  name: string
  enabled: boolean
  logic: 'or' | 'and'
  action: Action
  policy?: string
  matchers: DiversionMatcher[]
}

export interface DiversionConfig {
  enabled: boolean
  'ui-mode': DiversionUiMode
  'hide-unused-groups': boolean
  'private-network-direct': boolean
  'disable-isp-rules': boolean
  'isp-rules-position': 'before-custom' | 'after-custom'
  'auto-country-rules': boolean
  'country-or-region': DiversionRegion
  'current-group-name': string
  'auto-group-name': string
  'auto-url': string
  'auto-interval': number
  'auto-tolerance': number
  fallback: Action
  'fallback-policy'?: string
  groups: DiversionGroup[]
}

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const makeMatcher = (): DiversionMatcher => ({
  id: createUiId(),
  enabled: true,
  type: 'DOMAIN-SUFFIX',
  value: '',
})

export const makeGroup = (index: number): DiversionGroup => ({
  id: createUiId(),
  name: `自定义分流组 ${index + 1}`,
  enabled: true,
  logic: 'or',
  action: 'current',
  matchers: [makeMatcher()],
})

export const defaultConfig = (): DiversionConfig => ({
  enabled: false,
  'ui-mode': 'simple',
  'hide-unused-groups': false,
  'private-network-direct': true,
  'disable-isp-rules': false,
  'isp-rules-position': 'after-custom',
  'auto-country-rules': false,
  'country-or-region': '',
  'current-group-name': 'CVR-当前选择',
  'auto-group-name': 'CVR-自动选择',
  'auto-url': 'https://www.gstatic.com/generate_204',
  'auto-interval': 300,
  'auto-tolerance': 50,
  fallback: 'current',
  groups: [],
})

const normalizeMatcher = (value: unknown): DiversionMatcher => {
  const raw = isRecord(value) ? value : {}
  const type = MATCHER_TYPES.some(([item]) => item === raw.type)
    ? (raw.type as MatcherType)
    : 'DOMAIN-SUFFIX'

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createUiId(),
    enabled: raw.enabled !== false,
    type,
    value: typeof raw.value === 'string' ? raw.value : '',
    'no-resolve': raw['no-resolve'] === true,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
    url: typeof raw.url === 'string' ? raw.url : undefined,
    behavior:
      raw.behavior === 'domain' ||
      raw.behavior === 'ipcidr' ||
      raw.behavior === 'classical'
        ? raw.behavior
        : 'classical',
    format: raw.format === 'text' || raw.format === 'mrs' ? raw.format : 'yaml',
    interval:
      typeof raw.interval === 'number' && raw.interval > 0
        ? raw.interval
        : 86400,
  }
}

const normalizeGroup = (value: unknown, index: number): DiversionGroup => {
  const raw = isRecord(value) ? value : {}
  const action = ACTIONS.some(([item]) => item === raw.action)
    ? (raw.action as Action)
    : 'current'

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createUiId(),
    name:
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name
        : `自定义分流组 ${index + 1}`,
    enabled: raw.enabled !== false,
    logic: raw.logic === 'and' ? 'and' : 'or',
    action,
    policy: typeof raw.policy === 'string' ? raw.policy : undefined,
    matchers: Array.isArray(raw.matchers)
      ? raw.matchers.map(normalizeMatcher)
      : [makeMatcher()],
  }
}

export const normalizeConfig = (value: unknown): DiversionConfig => {
  const defaults = defaultConfig()
  const raw = isRecord(value) ? value : {}
  const fallback = ACTIONS.some(([item]) => item === raw.fallback)
    ? (raw.fallback as Action)
    : defaults.fallback
  const region: DiversionRegion =
    raw['country-or-region'] === 'cn' || raw['country-or-region'] === 'ir'
      ? raw['country-or-region']
      : ''

  return {
    enabled: raw.enabled === true,
    'ui-mode': raw['ui-mode'] === 'advanced' ? 'advanced' : 'simple',
    'hide-unused-groups': raw['hide-unused-groups'] === true,
    'private-network-direct': raw['private-network-direct'] !== false,
    'disable-isp-rules': raw['disable-isp-rules'] === true,
    'isp-rules-position':
      raw['isp-rules-position'] === 'before-custom'
        ? 'before-custom'
        : 'after-custom',
    'auto-country-rules': raw['auto-country-rules'] === true,
    'country-or-region': region,
    'current-group-name':
      typeof raw['current-group-name'] === 'string'
        ? raw['current-group-name']
        : defaults['current-group-name'],
    'auto-group-name':
      typeof raw['auto-group-name'] === 'string'
        ? raw['auto-group-name']
        : defaults['auto-group-name'],
    'auto-url':
      typeof raw['auto-url'] === 'string'
        ? raw['auto-url']
        : defaults['auto-url'],
    'auto-interval':
      typeof raw['auto-interval'] === 'number'
        ? raw['auto-interval']
        : defaults['auto-interval'],
    'auto-tolerance':
      typeof raw['auto-tolerance'] === 'number'
        ? raw['auto-tolerance']
        : defaults['auto-tolerance'],
    fallback,
    'fallback-policy':
      typeof raw['fallback-policy'] === 'string'
        ? raw['fallback-policy']
        : undefined,
    groups: Array.isArray(raw.groups)
      ? raw.groups.map(normalizeGroup)
      : defaults.groups,
  }
}

export const cleanMatcher = (matcher: DiversionMatcher): UnknownRecord => {
  const result: UnknownRecord = {
    enabled: matcher.enabled,
    type: matcher.type,
    value: matcher.value.trim(),
  }

  if (matcher.type === 'RULE-SET') {
    if (matcher.provider?.trim()) result.provider = matcher.provider.trim()
    if (matcher.url?.trim()) result.url = matcher.url.trim()
    result.behavior = matcher.behavior ?? 'classical'
    const requestedFormat = matcher.format ?? 'yaml'
    result.format =
      requestedFormat === 'mrs' && result.behavior === 'classical'
        ? 'yaml'
        : requestedFormat
    result.interval = matcher.interval ?? 86400
    if (result.behavior === 'ipcidr' && matcher['no-resolve']) {
      result['no-resolve'] = true
    }
  } else if (matcher.type !== 'RULE-SET-BUILDIN' && matcher['no-resolve']) {
    result['no-resolve'] = true
  }

  return result
}

export const cleanConfig = (config: DiversionConfig): UnknownRecord => ({
  ...config,
  'current-group-name': config['current-group-name'].trim(),
  'auto-group-name': config['auto-group-name'].trim(),
  'auto-url': config['auto-url'].trim(),
  groups: config.groups.map((group) => ({
    name: group.name.trim(),
    enabled: group.enabled,
    logic: group.logic,
    action: group.action,
    ...(group.action === 'policy' && group.policy?.trim()
      ? { policy: group.policy.trim() }
      : {}),
    matchers: group.matchers.map(cleanMatcher),
  })),
  ...(config.fallback === 'policy' && config['fallback-policy']?.trim()
    ? { 'fallback-policy': config['fallback-policy'].trim() }
    : {}),
})

const isValidMatcher = (matcher: DiversionMatcher) => {
  if (!matcher.enabled) return false
  const value = matcher.value.trim()
  if (matcher.type === 'RULE-SET-BUILDIN') {
    return /^(geosite|geoip|acl):[^\s:][^\s]*$/i.test(value)
  }
  if (matcher.type === 'RULE-SET') {
    return Boolean(value || matcher.provider?.trim() || matcher.url?.trim())
  }
  return Boolean(value)
}

export const validateConfig = (config: DiversionConfig): string | null => {
  if (
    config.enabled &&
    (!config['current-group-name'].trim() || !config['auto-group-name'].trim())
  ) {
    return '当前选择和自动选择策略组名称不能为空'
  }

  for (const group of config.groups) {
    if (!group.enabled || group.action === 'none') continue
    if (!group.name.trim()) return '存在未命名的分流组'
    if (group.action === 'policy' && !group.policy?.trim()) {
      return `分流组“${group.name}”缺少指定策略组名称`
    }
    if (!group.matchers.some(isValidMatcher)) {
      return `分流组“${group.name}”缺少有效规则`
    }
    const invalidBuiltin = group.matchers.find(
      (matcher) =>
        matcher.enabled &&
        matcher.type === 'RULE-SET-BUILDIN' &&
        !/^(geosite|geoip|acl):[^\s:][^\s]*$/i.test(matcher.value.trim()),
    )
    if (invalidBuiltin) {
      return `分流组“${group.name}”的内置规则应写成 geosite:name、geoip:name 或 acl:name`
    }
  }

  return null
}
