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
export type ProcessAttributionMatch = 'core' | 'tuple' | 'local-port' | 'none'

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

type AttributionListener = () => void

const MAX_ATTRIBUTION_ITEMS = 2_000
const attributionListeners = new Set<AttributionListener>()
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

const identityKey = (identity: ProcessIdentity) =>
  `${identity.pid}|${identity.processPath.toLowerCase()}|${identity.processName.toLowerCase()}`

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
  const exact = new Map<string, ProcessIdentity | null>()
  const localPort = new Map<string, ProcessIdentity | null>()

  if (snapshot?.supported) {
    for (const processConnection of snapshot.connections) {
      const local = parseEndpoint(processConnection.localAddress)
      if (!local?.port) continue

      const protocol = processConnection.protocol.trim().toUpperCase()
      const processPath = processConnection.processPath.trim()
      const identity: ProcessIdentity = {
        pid: processConnection.pid,
        processName:
          processConnection.processName.trim() ||
          processNameFromPath(processPath),
        processPath,
      }
      insertCandidate(localPort, `${protocol}|${local.port}`, identity)

      const remote = parseEndpoint(processConnection.remoteAddress)
      if (remote?.host && remote.port) {
        insertCandidate(
          exact,
          `${protocol}|${local.port}|${remote.host}|${remote.port}`,
          identity,
        )
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

    if ((currentProcess || currentPath) && !wasInjectedByWindows) {
      attributionUpdates.set(connection.id, {
        connectionId: connection.id,
        source: 'mihomo',
        match: 'core',
        processName: currentProcess || processNameFromPath(currentPath),
        processPath: currentPath,
        detail: '代理核心直接返回应用信息',
        updatedAt: Date.now(),
      })
      return connection
    }

    const protocol = String(metadata.network || '')
      .trim()
      .toUpperCase()
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
        processName: currentProcess,
        processPath: currentPath,
        detail: '连接缺少协议或源端口，无法与系统连接表关联',
        updatedAt: Date.now(),
      })
      return connection
    }

    const exactKey =
      destinationHost && destinationPort
        ? `${protocol}|${sourcePort}|${destinationHost}|${destinationPort}`
        : ''
    const localKey = `${protocol}|${sourcePort}`
    const exactCandidate = exactKey ? exact.get(exactKey) : undefined
    const localCandidate = localPort.get(localKey)
    const exactMatched = Boolean(exactCandidate)
    const identity = exactCandidate || localCandidate

    if (!identity) {
      if (wasInjectedByWindows && previousAttribution) {
        attributionUpdates.set(connection.id, previousAttribution)
        return connection
      }

      const errors = snapshot?.errors.filter(Boolean).join('；')
      let detail = 'Windows 连接表中未找到相同源端口的应用'
      if (!snapshot) detail = '正在等待 Windows 连接表采样'
      else if (!snapshot.supported)
        detail = errors || '当前平台不支持系统应用归因'
      else if (localPort.has(localKey) && localCandidate === null)
        detail = '同一源端口存在多个应用候选，已停止不安全的猜测'
      else if (errors) detail = `系统应用归因未完成：${errors}`

      attributionUpdates.set(connection.id, {
        connectionId: connection.id,
        source: 'unresolved',
        match: 'none',
        processName: currentProcess,
        processPath: currentPath,
        detail,
        updatedAt: Date.now(),
      })
      return connection
    }

    const attribution: ProcessAttribution = {
      connectionId: connection.id,
      source: 'windows',
      match: exactMatched ? 'tuple' : 'local-port',
      pid: identity.pid,
      processName: identity.processName,
      processPath: identity.processPath,
      detail: exactMatched
        ? 'Windows 连接表精确匹配协议、源端口和目标端点'
        : 'TUN 场景下按唯一源端口关联 Windows 应用',
      updatedAt: Date.now(),
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
