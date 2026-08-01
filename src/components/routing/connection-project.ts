import {
  resolveActionPolicy,
  type DiversionConfig,
  type DiversionProject,
} from '@/components/rule/diversion-manager/model'

export interface ConnectionProjectMatch {
  project: DiversionProject
  score: number
  reasons: string[]
  inferred: boolean
  policy: string
}

const normalizePath = (value: string) =>
  value.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()

const basename = (value: string) => {
  const parts = normalizePath(value).split('/').filter(Boolean)
  return parts.at(-1) ?? ''
}

const normalizeHost = (value: string) => {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '')
  if (!trimmed) return ''
  try {
    const url = trimmed.includes('://') ? trimmed : `https://${trimmed}`
    return new URL(url).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  } catch {
    return trimmed.replace(/^\[|\]$/g, '')
  }
}

const ipv4ToNumber = (value: string) => {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    const number = Number(part)
    if (!Number.isInteger(number) || number < 0 || number > 255) return null
    result = (result << 8) | number
  }
  return result >>> 0
}

const ipMatches = (ip: string, cidr: string) => {
  const candidate = ip.trim().replace(/^\[|\]$/g, '')
  const rule = cidr.trim().replace(/^\[|\]$/g, '')
  if (!candidate || !rule) return false
  if (!rule.includes('/')) return candidate.toLowerCase() === rule.toLowerCase()

  const [network, prefixText] = rule.split('/', 2)
  if (candidate.includes(':') || network.includes(':')) {
    return (
      prefixText === '128' && candidate.toLowerCase() === network.toLowerCase()
    )
  }

  const candidateNumber = ipv4ToNumber(candidate)
  const networkNumber = ipv4ToNumber(network)
  const prefix = Number(prefixText)
  if (
    candidateNumber === null ||
    networkNumber === null ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (candidateNumber & mask) === (networkNumber & mask)
}

const portMatches = (port: string, rule: string) => {
  const value = Number(port)
  if (!Number.isInteger(value)) return false
  const trimmed = rule.trim()
  const range = trimmed.match(/^(\d+)\s*[-:]\s*(\d+)$/)
  if (range) {
    const start = Number(range[1])
    const end = Number(range[2])
    return value >= Math.min(start, end) && value <= Math.max(start, end)
  }
  return value === Number(trimmed)
}

const domainMatches = (host: string, domain: string) => {
  const normalized = normalizeHost(domain).replace(/^\*\./, '')
  return Boolean(
    host &&
      normalized &&
      (host === normalized || host.endsWith(`.${normalized}`)),
  )
}

const projectConditionCount = (project: DiversionProject) =>
  project.processNames.length +
  project.processPaths.length +
  project.domains.length +
  project.ipCidrs.length +
  project.destinationPorts.length

export const resolveConnectionProject = (
  connection: IConnectionsItem,
  config: DiversionConfig | null | undefined,
): ConnectionProjectMatch | null => {
  if (!config) return null
  const metadata = connection.metadata
  const processPath = normalizePath(String(metadata.processPath ?? ''))
  const processName = String(metadata.process ?? '')
    .trim()
    .toLowerCase()
  const processBasename = basename(processPath || processName)
  const host = normalizeHost(String(metadata.host ?? ''))
  const destinationIP = String(
    metadata.destinationIP || metadata.remoteDestination || '',
  ).trim()
  const destinationPort = String(metadata.destinationPort ?? '').trim()
  const hasRuntimeProcess = Boolean(processPath || processName)

  const matches = config.projects
    .filter((project) => project.enabled && project.action !== 'none')
    .map((project) => {
      let score = 0
      const reasons: string[] = []

      if (
        processPath &&
        project.processPaths.some(
          (value) => normalizePath(value) === processPath,
        )
      ) {
        score += 120
        reasons.push('完整程序路径')
      }

      if (
        processBasename &&
        project.processNames.some((value) => {
          const expected = value.trim().toLowerCase()
          return expected === processName || expected === processBasename
        })
      ) {
        score += 100
        reasons.push('程序名称')
      }

      if (host && project.domains.some((value) => domainMatches(host, value))) {
        score += 60
        reasons.push('域名')
      }

      if (
        destinationIP &&
        project.ipCidrs.some((value) => ipMatches(destinationIP, value))
      ) {
        score += 50
        reasons.push('目标 IP')
      }

      if (
        destinationPort &&
        project.destinationPorts.some((value) =>
          portMatches(destinationPort, value),
        )
      ) {
        score += projectConditionCount(project) === 1 ? 50 : 15
        reasons.push('目标端口')
      }

      return {
        project,
        score,
        reasons,
        inferred: !hasRuntimeProcess,
        policy: resolveActionPolicy(config, project.action, project.policy),
      }
    })
    .filter((match) => match.score >= 50)
    .sort((left, right) => right.score - left.score)

  return matches[0] ?? null
}

export const connectionUsesPolicy = (
  connection: IConnectionsItem,
  policy: string,
) => {
  const expected = policy.trim().toLowerCase()
  return Boolean(
    expected &&
      connection.chains.some(
        (chain) => chain.trim().toLowerCase() === expected,
      ),
  )
}
