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

interface ProcessIdentity {
  pid: number
  processName: string
  processPath: string
}

interface Endpoint {
  host: string
  port: string
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

export const getSystemProcessConnections = () =>
  invoke<ProcessConnectionSnapshot>('get_network_interfaces_info', {
    kind: 'process-connections',
  })

export const enrichConnectionsWithProcesses = (
  connections: IConnectionsItem[],
  snapshot?: ProcessConnectionSnapshot,
) => {
  if (!snapshot?.supported || snapshot.connections.length === 0) {
    return connections
  }

  // 深度联动安全约束：优先匹配完整连接四元组，仅在源端口归属唯一时降级。
  const exact = new Map<string, ProcessIdentity | null>()
  const localPort = new Map<string, ProcessIdentity | null>()

  for (const processConnection of snapshot.connections) {
    const local = parseEndpoint(processConnection.localAddress)
    if (!local?.port) continue

    const protocol = processConnection.protocol.trim().toUpperCase()
    const identity: ProcessIdentity = {
      pid: processConnection.pid,
      processName: processConnection.processName.trim(),
      processPath: processConnection.processPath.trim(),
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

  let changed = false
  const enriched = connections.map((connection) => {
    const metadata = connection.metadata
    if (metadata.process && metadata.processPath) return connection

    const protocol = String(metadata.network || '')
      .trim()
      .toUpperCase()
    const sourcePort = String(metadata.sourcePort || '').trim()
    const destinationHost = normalizeHost(
      String(metadata.destinationIP || metadata.remoteDestination || ''),
    )
    const destinationPort = String(metadata.destinationPort || '').trim()
    if (!protocol || !sourcePort) return connection

    const identity =
      (destinationHost && destinationPort
        ? exact.get(
            `${protocol}|${sourcePort}|${destinationHost}|${destinationPort}`,
          )
        : undefined) ?? localPort.get(`${protocol}|${sourcePort}`)
    if (!identity) return connection

    const process = metadata.process || identity.processName
    const processPath = metadata.processPath || identity.processPath
    if (process === metadata.process && processPath === metadata.processPath) {
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

  return changed ? enriched : connections
}
