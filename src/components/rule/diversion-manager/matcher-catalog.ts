import type { DiversionMatcher, MatcherType, UnknownRecord } from './model'

export interface MatcherTypeOption {
  type: MatcherType
  label: string
  description: string
}

export interface MatcherTypeGroup {
  title: string
  options: MatcherTypeOption[]
}

export interface MatcherValueOption {
  value: string
  label: string
  description?: string
}

export const MATCHER_TYPE_GROUPS: MatcherTypeGroup[] = [
  {
    title: '常用规则',
    options: [
      {
        type: 'RULE-SET-BUILDIN',
        label: '内置规则集',
        description: '从 GeoSite、GeoIP 或 ACL 分类中选择。',
      },
      {
        type: 'DOMAIN-SUFFIX',
        label: '域名后缀',
        description: '匹配某个域名及它的全部子域名。',
      },
      {
        type: 'DOMAIN',
        label: '完整域名',
        description: '只匹配一个完整域名。',
      },
      {
        type: 'IP-CIDR',
        label: 'IP 地址或网段',
        description: '匹配 IPv4/IPv6 地址或 CIDR 网段。',
      },
    ],
  },
  {
    title: '应用程序',
    options: [
      {
        type: 'PROCESS-NAME',
        label: '进程名称',
        description: '按程序进程名分流，例如 chrome.exe。',
      },
      {
        type: 'PROCESS-PATH',
        label: '进程路径',
        description: '按程序完整路径分流。',
      },
    ],
  },
  {
    title: '网络条件',
    options: [
      {
        type: 'DST-PORT',
        label: '目标端口',
        description: '按目标端口或端口范围分流。',
      },
      {
        type: 'NETWORK',
        label: '网络协议',
        description: '按 TCP、UDP 等网络协议分流。',
      },
    ],
  },
  {
    title: '高级规则',
    options: [
      {
        type: 'DOMAIN-KEYWORD',
        label: '域名关键词',
        description: '域名中包含关键词时匹配。',
      },
      {
        type: 'DOMAIN-REGEX',
        label: '域名正则',
        description: '使用正则表达式匹配域名。',
      },
      {
        type: 'GEOSITE',
        label: 'GeoSite 分类',
        description: '直接填写 GeoSite 分类名称。',
      },
      {
        type: 'GEOIP',
        label: 'GeoIP 分类',
        description: '直接填写国家、地区或私网分类。',
      },
      {
        type: 'RULE-SET',
        label: '远程或已有 Rule Set',
        description: '引用已有 provider，或填写远程规则集 URL。',
      },
    ],
  },
]

const COMMON_GEOSITE: MatcherValueOption[] = [
  { value: 'cn', label: '中国大陆网站' },
  { value: 'geolocation-!cn', label: '非中国大陆网站' },
  { value: 'category-ads-all', label: '常见广告' },
  { value: 'google', label: 'Google' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'github', label: 'GitHub' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'microsoft', label: 'Microsoft' },
  { value: 'apple', label: 'Apple' },
  { value: 'netflix', label: 'Netflix' },
  { value: 'openai', label: 'OpenAI' },
]

const COMMON_GEOIP: MatcherValueOption[] = [
  { value: 'CN', label: '中国大陆 IP' },
  { value: 'private', label: '私有网络 IP' },
  { value: 'IR', label: '伊朗 IP' },
]

const COMMON_NETWORK: MatcherValueOption[] = [
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
]

const COMMON_PORTS: MatcherValueOption[] = [
  { value: '80', label: 'HTTP（80）' },
  { value: '443', label: 'HTTPS / QUIC（443）' },
  { value: '53', label: 'DNS（53）' },
  { value: '853', label: 'DNS over TLS（853）' },
  { value: '3478-3481', label: 'STUN / TURN（3478-3481）' },
  { value: '6881-6999', label: '常见 BitTorrent 端口' },
]

export const createMatcherForType = (type: MatcherType): DiversionMatcher => ({
  id: crypto.randomUUID(),
  enabled: true,
  type,
  value: '',
  ...(type === 'IP-CIDR' || type === 'GEOIP' ? { 'no-resolve': true } : {}),
  ...(type === 'RULE-SET'
    ? {
        behavior: 'classical' as const,
        format: 'yaml' as const,
        interval: 86400,
      }
    : {}),
})

export const matcherValueOptions = (
  type: MatcherType,
  ruleProviders: UnknownRecord = {},
): MatcherValueOption[] => {
  if (type === 'RULE-SET-BUILDIN') {
    return [
      ...COMMON_GEOSITE.map((item) => ({
        ...item,
        value: `geosite:${item.value}`,
        description: 'GeoSite',
      })),
      ...COMMON_GEOIP.map((item) => ({
        ...item,
        value: `geoip:${item.value}`,
        description: 'GeoIP',
      })),
    ]
  }
  if (type === 'GEOSITE') return COMMON_GEOSITE
  if (type === 'GEOIP') return COMMON_GEOIP
  if (type === 'NETWORK') return COMMON_NETWORK
  if (type === 'DST-PORT') return COMMON_PORTS
  if (type === 'RULE-SET') {
    return Object.keys(ruleProviders)
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
      .map((value) => ({
        value,
        label: value,
        description: '已有 rule-provider',
      }))
  }
  return []
}

export const hasMatcherValuePicker = (type: MatcherType) =>
  [
    'RULE-SET-BUILDIN',
    'GEOSITE',
    'GEOIP',
    'NETWORK',
    'DST-PORT',
    'RULE-SET',
  ].includes(type)
