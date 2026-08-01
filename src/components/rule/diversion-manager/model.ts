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
export type DiversionRegion = '' | 'cn' | 'ir'
export type DiversionProjectKind = 'program' | 'project'

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
  'project-id'?: string
}

export interface DiversionProject {
  id: string
  groupId: string
  kind: DiversionProjectKind
  name: string
  description: string
  enabled: boolean
  action: Action
  policy?: string
  processNames: string[]
  processPaths: string[]
  domains: string[]
  ipCidrs: string[]
  destinationPorts: string[]
}

export interface DiversionConfig {
  enabled: boolean
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
  projects: DiversionProject[]
  groups: DiversionGroup[]
}

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizeStringList = (value: unknown) => {
  if (!Array.isArray(value)) return []
  const unique = new Map<string, string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    unique.set(trimmed.toLowerCase(), trimmed)
  }
  return [...unique.values()]
}

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

export const makeProject = (
  index: number,
  patch: Partial<DiversionProject> = {},
): DiversionProject => {
  const id = patch.id?.trim() || createUiId()
  return {
    id,
    groupId: patch.groupId?.trim() || `project-${id}`,
    kind: patch.kind === 'project' ? 'project' : 'program',
    name: patch.name?.trim() || `程序或项目 ${index + 1}`,
    description: patch.description ?? '',
    enabled: patch.enabled !== false,
    action: patch.action ?? 'current',
    policy: patch.policy,
    processNames: patch.processNames ?? [],
    processPaths: patch.processPaths ?? [],
    domains: patch.domains ?? [],
    ipCidrs: patch.ipCidrs ?? [],
    destinationPorts: patch.destinationPorts ?? [],
  }
}

export const defaultConfig = (): DiversionConfig => ({
  enabled: false,
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
  projects: [],
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
    'project-id':
      typeof raw['project-id'] === 'string' && raw['project-id'].trim()
        ? raw['project-id'].trim()
        : undefined,
  }
}

const normalizeProject = (value: unknown, index: number): DiversionProject => {
  const raw = isRecord(value) ? value : {}
  const id =
    typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : createUiId()
  const action = ACTIONS.some(([item]) => item === raw.action)
    ? (raw.action as Action)
    : 'current'

  return {
    id,
    groupId:
      typeof raw.groupId === 'string' && raw.groupId.trim()
        ? raw.groupId.trim()
        : `project-${id}`,
    kind: raw.kind === 'project' ? 'project' : 'program',
    name:
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim()
        : `程序或项目 ${index + 1}`,
    description: typeof raw.description === 'string' ? raw.description : '',
    enabled: raw.enabled !== false,
    action,
    policy: typeof raw.policy === 'string' ? raw.policy : undefined,
    processNames: normalizeStringList(raw.processNames),
    processPaths: normalizeStringList(raw.processPaths),
    domains: normalizeStringList(raw.domains),
    ipCidrs: normalizeStringList(raw.ipCidrs),
    destinationPorts: normalizeStringList(raw.destinationPorts),
  }
}

const projectMatchers = (project: DiversionProject): DiversionMatcher[] => {
  const matcher = (
    type: MatcherType,
    value: string,
    index: number,
    noResolve = false,
  ): DiversionMatcher => ({
    id: `${project.id}:${type}:${index}`,
    enabled: true,
    type,
    value,
    ...(noResolve ? { 'no-resolve': true } : {}),
  })

  return [
    ...project.processNames.map((value, index) =>
      matcher('PROCESS-NAME', value, index),
    ),
    ...project.processPaths.map((value, index) =>
      matcher('PROCESS-PATH', value, index),
    ),
    ...project.domains.map((value, index) =>
      matcher('DOMAIN-SUFFIX', value, index),
    ),
    ...project.ipCidrs.map((value, index) =>
      matcher('IP-CIDR', value, index, true),
    ),
    ...project.destinationPorts.map((value, index) =>
      matcher('DST-PORT', value, index),
    ),
  ]
}

export const syncProjectGroups = (config: DiversionConfig): DiversionConfig => {
  const projectIds = new Set(config.projects.map((project) => project.id))
  const unmanagedGroups = config.groups.filter(
    (group) => !group['project-id'] || projectIds.has(group['project-id']),
  )
  const managed = config.projects.map((project) => ({
    id: project.groupId,
    name: `${project.kind === 'program' ? '程序' : '项目'} · ${project.name}`,
    enabled: project.enabled,
    logic: 'or' as const,
    action: project.action,
    policy: project.action === 'policy' ? project.policy : undefined,
    matchers: projectMatchers(project),
    'project-id': project.id,
  }))

  const manual = unmanagedGroups.filter((group) => !group['project-id'])
  return {
    ...config,
    enabled:
      config.enabled ||
      config.projects.some(
        (project) => project.enabled && project.action !== 'none',
      ),
    groups: [...managed, ...manual],
  }
}

export const resolveActionPolicy = (
  config: DiversionConfig,
  action: Action,
  policy?: string,
) => {
  switch (action) {
    case 'current':
      return config['current-group-name']
    case 'auto-select':
      return config['auto-group-name']
    case 'direct':
      return 'DIRECT'
    case 'reject':
      return 'REJECT'
    case 'reject-drop':
      return 'REJECT-DROP'
    case 'policy':
      return policy?.trim() || ''
    default:
      return ''
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

  return syncProjectGroups({
    enabled: raw.enabled === true,
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
    projects: Array.isArray(raw.projects)
      ? raw.projects.map(normalizeProject)
      : defaults.projects,
    groups: Array.isArray(raw.groups)
      ? raw.groups.map(normalizeGroup)
      : defaults.groups,
  })
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

const cleanProject = (project: DiversionProject): UnknownRecord => ({
  id: project.id,
  groupId: project.groupId,
  kind: project.kind,
  name: project.name.trim(),
  description: project.description.trim(),
  enabled: project.enabled,
  action: project.action,
  ...(project.action === 'policy' && project.policy?.trim()
    ? { policy: project.policy.trim() }
    : {}),
  processNames: normalizeStringList(project.processNames),
  processPaths: normalizeStringList(project.processPaths),
  domains: normalizeStringList(project.domains),
  ipCidrs: normalizeStringList(project.ipCidrs),
  destinationPorts: normalizeStringList(project.destinationPorts),
})

export const cleanConfig = (input: DiversionConfig): UnknownRecord => {
  const config = syncProjectGroups(input)
  return {
    enabled: config.enabled,
    'hide-unused-groups': config['hide-unused-groups'],
    'private-network-direct': config['private-network-direct'],
    'disable-isp-rules': config['disable-isp-rules'],
    'isp-rules-position': config['isp-rules-position'],
    'auto-country-rules': config['auto-country-rules'],
    'country-or-region': config['country-or-region'],
    'current-group-name': config['current-group-name'].trim(),
    'auto-group-name': config['auto-group-name'].trim(),
    'auto-url': config['auto-url'].trim(),
    'auto-interval': config['auto-interval'],
    'auto-tolerance': config['auto-tolerance'],
    fallback: config.fallback,
    ...(config.fallback === 'policy' && config['fallback-policy']?.trim()
      ? { 'fallback-policy': config['fallback-policy'].trim() }
      : {}),
    projects: config.projects.map(cleanProject),
    groups: config.groups.map((group) => ({
      id: group.id,
      name: group.name.trim(),
      enabled: group.enabled,
      logic: group.logic,
      action: group.action,
      ...(group.action === 'policy' && group.policy?.trim()
        ? { policy: group.policy.trim() }
        : {}),
      ...(group['project-id'] ? { 'project-id': group['project-id'] } : {}),
      matchers: group.matchers.map(cleanMatcher),
    })),
  }
}

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

const projectConditionCount = (project: DiversionProject) =>
  project.processNames.length +
  project.processPaths.length +
  project.domains.length +
  project.ipCidrs.length +
  project.destinationPorts.length

export const validateConfig = (input: DiversionConfig): string | null => {
  const config = syncProjectGroups(input)
  if (
    config.enabled &&
    (!config['current-group-name'].trim() || !config['auto-group-name'].trim())
  ) {
    return '当前选择和自动选择策略组名称不能为空'
  }

  const projectNames = new Set<string>()
  const projectIds = new Set<string>()
  const projectGroupIds = new Set<string>()
  for (const project of config.projects) {
    const name = project.name.trim()
    if (!name) return '存在未命名的程序或项目档案'
    const key = name.toLowerCase()
    if (projectNames.has(key)) return `程序或项目“${name}”名称重复`
    projectNames.add(key)
    if (projectIds.has(project.id)) return `程序或项目“${name}”的内部 ID 重复`
    projectIds.add(project.id)
    if (projectGroupIds.has(project.groupId)) {
      return `程序或项目“${name}”的托管规则组 ID 重复`
    }
    projectGroupIds.add(project.groupId)
    if (
      project.enabled &&
      project.action !== 'none' &&
      projectConditionCount(project) === 0
    ) {
      return `程序或项目“${name}”至少需要一个程序、域名、IP 或端口条件`
    }
    if (project.action === 'policy' && !project.policy?.trim()) {
      return `程序或项目“${name}”缺少指定策略组名称`
    }
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
