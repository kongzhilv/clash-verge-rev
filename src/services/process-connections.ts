import { invoke } from '@tauri-apps/api/core'

export interface ProcessConnectionInfo {
  pid: number
  processName: string
  processPath: string
  protocol: string
  localAddress: string
  remoteAddress?: string | null
  state?: string | null
}

export interface ProcessConnectionSnapshot {
  supported: boolean
  source: string
  connections: ProcessConnectionInfo[]
  errors: string[]
}

export type ProcessAttributionSource = 'mihomo' | 'windows' | 'unresolved'
export type ProcessAttributionMatch =
  | 'core'
  | 'tuple'
  | 'local-endpoint'
  | 'local-port'
  | 'recent-tuple'
  | 'recent-local-endpoint'
  | 'none'

export interface ProcessAttribution {
  connectionId: string
  source: ProcessAttributionSource
  match: ProcessAttributionMatch
  pid?: number
  processName: string
  processPath: string
  detail: string
  updatedAt: number
}

export interface ProcessAttributionSnapshot {
  version: number
  items: ReadonlyMap<string, ProcessAttribution>
}

interface ProcessIdentity {
  pid: number
  processName: string
  processPath: string
}

interface Endpoint {
  host: string
  port: string
}

interface RecentCandidate {
  identity: ProcessIdentity | null
  seenAt: number
}

type AttributionListener = () => void

const MAX_ATTRIBUTION_ITEMS = 2_000
const RECENT_ENDPOINT_TTL_MS = 20_000
const PID_PLACEHOLDER_PATTERN = /^PID\s+\d+$/i
const INACTIVE_TCP_STATES = new Set([
  'CLOSED',
  'LISTEN',
  'TIME-WAIT',
  'DELETE-TCB',
])
const attributionListeners = new Set<AttributionListener>()
const recentExactCandidates = new Map<string, RecentCandidate>()
const recentLocalEndpointCandidates = new Map<string, RecentCandidate>()
let processAttributionSnapshot: ProcessAttributionSnapshot = {
  version: 0,
  items: new Map(),
}

const normalizeHost = (value: string) =>
  value
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.+$/, '')
    .replace(/^::ffff:/i, '')
    .toLowerCase()

const parseEndpoint = (value?: string | null): Endpoint | null => {
  const input = value?.trim()
  if (!input) return null

  if (input.startsWith('[')) {
    const closing = input.lastIndexOf(']')
    if (closing < 0 || input[closing + 1] !== ':') return null
    return {
      host: normalizeHost(input.slice(1, closing)),
      port: input.slice(closing + 2),
    }
  }

  const colon = input.lastIndexOf(':')
  if (colon < 0) return null
  return {
    host: normalizeHost(input.slice(0, colon)),
    port: input.slice(colon + 1),
  }
}

const processNameFromPath = (processPath: string) =>
  processPath.split(/[\\/]/).filter(Boolean).at(-1) ?? ''

const hasResolvedProcessDetails = (processName: string, processPath: string) =>
  Boolean(
    processPath.trim() ||
      (processName.trim() && !PID_PLACEHOLDER_PATTERN.test(processName.trim())),
  )

const snapshotIdentity = (
  connection: ProcessConnectionInfo,
): ProcessIdentity | undefined => {
  if (connection.pid <= 0) return undefined
  const processPath = connection.processPath.trim()
  const reportedName = connection.processName.trim()
  const processName =
    (PID_PLACEHOLDER_PATTERN.test(reportedName) ? '' : reportedName) ||
    processNameFromPath(processPath)
  if (!hasResolvedProcessDetails(processName, processPath)) return undefined
  return { pid: connection.pid, processName, processPath }
}

const isUsableEndpointOwner = (connection: ProcessConnectionInfo) => {
  const protocol = connection.protocol.trim().toUpperCase()
  const state = connection.state?.trim().toUpperCase()
  return !(protocol === 'TCP' && state && INACTIVE_TCP_STATES.has(state))
}

const identityKey = (identity: ProcessIdentity) =>
  `${identity.pid}|${identity.processPath.toLowerCase()}|${identity.processName.toLowerCase()}`

const localEndpointKey = (protocol: string, host: string, port: string) =>
  `${protocol}|${host}|${port}`

const exactEndpointKey = (
  protocol: string,
  localHost: string,
  localPort: string,
  remoteHost: string,
  remotePort: string,
) => `${protocol}|${localHost}|${localPort}|${remoteHost}|${remotePort}`

const insertCandidate = (
  map: Map<string, ProcessIdentity | null>,
  key: string,
  identity: ProcessIdentity,
) => {
  const current = map.get(key)
  if (current === undefined) {
    map.set(key, identity)
    return
  }
  if (current && identityKey(current) !== identityKey(identity)) {
    map.set(key, null)
  }
}

const rememberCandidate = (
  map: Map<string, RecentCandidate>,
  key: string,
  identity: ProcessIdentity,
  now: number,
) => {
  const current = map.get(key)
  if (!current || now - current.seenAt > RECENT_ENDPOINT_TTL_MS) {
    map.set(key, { identity, seenAt: now })
    return
  }

  map.set(key, {
    identity:
      current.identity &&
      identityKey(current.identity) === identityKey(identity)
        ? identity
        : null,
    seenAt: now,
  })
}

const purgeRecentCandidates = (
  map: Map<string, RecentCandidate>,
  now: number,
) => {
  for (const [key, candidate] of map) {
    if (now - candidate.seenAt > RECENT_ENDPOINT_TTL_MS) map.delete(key)
  }
}

const readRecentCandidate = (
  map: Map<string, RecentCandidate>,
  key: string,
  now: number,
) => {
  const candidate = map.get(key)
  if (!candidate || now - candidate.seenAt > RECENT_ENDPOINT_TTL_MS) {
    return undefined
  }
  return candidate.identity ?? undefined
}

const sameAttribution = (
  left: ProcessAttribution | undefined,
  right: ProcessAttribution,
) =>
  left?.connectionId === right.connectionId &&
  left.source === right.source &&
  left.match === right.match &&
  left.pid === right.pid &&
  left.processName === right.processName &&
  left.processPath === right.processPath &&
  left.detail === right.detail

const publishAttributions = (updates: Map<string, ProcessAttribution>) => {
  if (updates.size === 0) return

  const nextItems = new Map(processAttributionSnapshot.items)
  let changed = false

  for (const [connectionId, attribution] of updates) {
    if (sameAttribution(nextItems.get(connectionId), attribution)) continue
    nextItems.set(connectionId, attribution)
    changed = true
  }

  if (nextItems.size > MAX_ATTRIBUTION_ITEMS) {
    const removeCount = nextItems.size - MAX_ATTRIBUTION_ITEMS
    const oldest = [...nextItems.values()]
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(0, removeCount)
    for (const attribution of oldest) {
      nextItems.delete(attribution.connectionId)
    }
    changed = true
  }

  if (!changed) return
  processAttributionSnapshot = {
    version: processAttributionSnapshot.version + 1,
    items: nextItems,
  }
  attributionListeners.forEach((listener) => listener())
}

export const subscribeProcessAttribution = (listener: AttributionListener) => {
  attributionListeners.add(listener)
  return () => attributionListeners.delete(listener)
}

export const getProcessAttributionSnapshot = () => processAttributionSnapshot

export const getSystemProcessConnections = () =>
  invoke<ProcessConnectionSnapshot>('get_network_interfaces_info', {
    kind: 'process-connections',
  })

export const enrichConnectionsWithProcesses = (
  connections: IConnectionsItem[],
  snapshot?: ProcessConnectionSnapshot,
) => {
  const now = Date.now()
  const exact = new Map<string, ProcessIdentity | null>()
  const localEndpoint = new Map<string, ProcessIdentity | null>()
  const localPort = new Map<string, ProcessIdentity | null>()

  purgeRecentCandidates(recentExactCandidates, now)
  purgeRecentCandidates(recentLocalEndpointCandidates, now)

  if (snapshot?.supported) {
    const resolvedIdentitiesByPid = new Map<number, ProcessIdentity>()
    for (const processConnection of snapshot.connections) {
      const identity = snapshotIdentity(processConnection)
      if (!identity) continue
      const current = resolvedIdentitiesByPid.get(identity.pid)
      if (!current || (!current.processPath && identity.processPath)) {
        resolvedIdentitiesByPid.set(identity.pid, identity)
      }
    }

    for (const processConnection of snapshot.connections) {
      if (!isUsableEndpointOwner(processConnection)) continue
      const local = parseEndpoint(processConnection.localAddress)
      if (!local?.port) continue

      const protocol = processConnection.protocol.trim().toUpperCase()
      if (!protocol) continue

      const identity =
        resolvedIdentitiesByPid.get(processConnection.pid) ??
        snapshotIdentity(processConnection)
      if (!identity) continue

      const localKey = localEndpointKey(protocol, local.host, local.port)
      insertCandidate(localEndpoint, localKey, identity)
      insertCandidate(localPort, `${protocol}|${local.port}`, identity)
      rememberCandidate(recentLocalEndpointCandidates, localKey, identity, now)

      const remote = parseEndpoint(processConnection.remoteAddress)
      if (remote?.host && remote.port) {
        const exactKey = exactEndpointKey(
          protocol,
          local.host,
          local.port,
          remote.host,
          remote.port,
        )
        insertCandidate(exact, exactKey, identity)
        rememberCandidate(recentExactCandidates, exactKey, identity, now)
      }
    }
  }

  const attributionUpdates = new Map<string, ProcessAttribution>()
  let changed = false
  const enriched = connections.map((connection) => {
    const metadata = connection.metadata
    const currentProcess = String(metadata.process ?? '').trim()
    const currentPath = String(metadata.processPath ?? '').trim()
    const previousAttribution = processAttributionSnapshot.items.get(
      connection.id,
    )
    const wasInjectedByWindows =
      previousAttribution?.source === 'windows' &&
      currentProcess === previousAttribution.processName &&
      currentPath === previousAttribution.processPath

    const currentIdentityResolved = hasResolvedProcessDetails(
      currentProcess,
      currentPath,
    )

    if (currentIdentityResolved && !wasInjectedByWindows) {
      attributionUpdates.set(connection.id, {
        connectionId: connection.id,
        source: 'mihomo',
        match: 'core',
        processName: currentProcess || processNameFromPath(currentPath),
        processPath: currentPath,
        detail: '代理核心直接返回应用信息',
        updatedAt: now,
      })
      return connection
    }

    const protocol = String(metadata.network || '')
      .trim()
      .toUpperCase()
    const sourceHost = normalizeHost(String(metadata.sourceIP || ''))
    const sourcePort = String(metadata.sourcePort || '').trim()
    const destinationHost = normalizeHost(
      String(metadata.destinationIP || metadata.remoteDestination || ''),
    )
    const destinationPort = String(metadata.destinationPort || '').trim()

    if (!protocol || !sourcePort) {
      attributionUpdates.set(connection.id, {
        connectionId: connection.id,
        source: 'unresolved',
        match: 'none',
        processName: currentIdentityResolved ? currentProcess : '',
        processPath: currentIdentityResolved ? currentPath : '',
        detail: '连接缺少协议或源端口，无法与系统连接表关联',
        updatedAt: now,
      })
      return connection
    }

    const exactKey =
      sourceHost && destinationHost && destinationPort
        ? exactEndpointKey(
            protocol,
            sourceHost,
            sourcePort,
            destinationHost,
            destinationPort,
          )
        : ''
    const localKey = sourceHost
      ? localEndpointKey(protocol, sourceHost, sourcePort)
      : ''
    const portKey = `${protocol}|${sourcePort}`

    const exactCandidate = exactKey ? exact.get(exactKey) : undefined
    const localEndpointCandidate = localKey
      ? localEndpoint.get(localKey)
      : undefined
    const localPortCandidate = localPort.get(portKey)
    const recentExactCandidate =
      !exactCandidate && exactKey
        ? readRecentCandidate(recentExactCandidates, exactKey, now)
        : undefined
    const recentLocalCandidate =
      !localEndpointCandidate && localKey
        ? readRecentCandidate(recentLocalEndpointCandidates, localKey, now)
        : undefined

    const identity =
      exactCandidate ||
      localEndpointCandidate ||
      recentExactCandidate ||
      recentLocalCandidate ||
      localPortCandidate

    let match: ProcessAttributionMatch = 'none'
    if (exactCandidate) match = 'tuple'
    else if (localEndpointCandidate) match = 'local-endpoint'
    else if (recentExactCandidate) match = 'recent-tuple'
    else if (recentLocalCandidate) match = 'recent-local-endpoint'
    else if (localPortCandidate) match = 'local-port'

    if (!identity) {
      const errors = snapshot?.errors.filter(Boolean).join('；')
      let detail = 'Windows 连接表中未找到对应应用'
      if (!snapshot) detail = '正在等待 Windows 连接表采样'
      else if (!snapshot.supported)
        detail = errors || '当前平台不支持系统应用归因'
      else if (
        (localKey && localEndpoint.has(localKey) && !localEndpointCandidate) ||
        (localPort.has(portKey) && !localPortCandidate)
      )
        detail = '同一端点存在多个应用候选，已停止不安全的猜测'
      else if (errors) detail = `系统应用归因未完成：${errors}`

      attributionUpdates.set(connection.id, {
        connectionId: connection.id,
        source: 'unresolved',
        match: 'none',
        processName: currentIdentityResolved ? currentProcess : '',
        processPath: currentIdentityResolved ? currentPath : '',
        detail,
        updatedAt: now,
      })
      if (!currentIdentityResolved && (currentProcess || currentPath)) {
        changed = true
        return {
          ...connection,
          metadata: { ...metadata, process: '', processPath: '' },
        }
      }
      return connection
    }

    const detailByMatch: Record<
      Exclude<ProcessAttributionMatch, 'core' | 'none'>,
      string
    > = {
      tuple: 'Windows 连接表精确匹配本地和目标端点',
      'local-endpoint': 'TUN/Fake-IP 场景下按本地端点识别应用',
      'local-port': '按唯一源端口识别应用',
      'recent-tuple': '短连接已结束，使用最近的精确端点记录识别应用',
      'recent-local-endpoint':
        '短连接已结束，使用最近的 TUN/Fake-IP 本地端点记录识别应用',
    }
    const attribution: ProcessAttribution = {
      connectionId: connection.id,
      source: 'windows',
      match,
      pid: identity.pid,
      processName: identity.processName,
      processPath: identity.processPath,
      detail: detailByMatch[match as keyof typeof detailByMatch],
      updatedAt: now,
    }
    attributionUpdates.set(connection.id, attribution)

    const process = currentProcess || identity.processName
    const processPath = currentPath || identity.processPath
    if (process === currentProcess && processPath === currentPath) {
      return connection
    }

    changed = true
    return {
      ...connection,
      metadata: {
        ...metadata,
        process,
        processPath,
      },
    }
  })

  publishAttributions(attributionUpdates)
  return changed ? enriched : connections
}
