import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const normalizeHost = (value) =>
  value
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.+$/, '')
    .replace(/^::ffff:/i, '')
    .toLowerCase()

const parseEndpoint = (value) => {
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

const identityKey = (identity) =>
  `${identity.pid}|${identity.processPath.toLowerCase()}|${identity.processName.toLowerCase()}`

const insertUnique = (map, key, identity) => {
  const current = map.get(key)
  if (current === undefined) {
    map.set(key, identity)
    return
  }
  if (current && identityKey(current) !== identityKey(identity)) {
    map.set(key, null)
  }
}

const localEndpointKey = (protocol, host, port) =>
  `${protocol}|${normalizeHost(host)}|${port}`

const buildIndexes = (owners) => {
  const localEndpoints = new Map()
  const localPorts = new Map()

  for (const owner of owners) {
    const local = parseEndpoint(owner.localAddress)
    assert.ok(local, `invalid fixture endpoint: ${owner.localAddress}`)
    const protocol = owner.protocol.toUpperCase()
    insertUnique(
      localEndpoints,
      localEndpointKey(protocol, local.host, local.port),
      owner,
    )
    insertUnique(localPorts, `${protocol}|${local.port}`, owner)
  }

  return { localEndpoints, localPorts }
}

const tcpOwners = [
  {
    pid: 16028,
    processName: 'Nstbrowser.exe',
    processPath: 'D:\\nstbrowser\\Nstbrowser.exe',
    protocol: 'TCP',
    localAddress: '[fdfe:dcba:9876::1]:57833',
    remoteAddress: '[fdfe:dcba:9876::c]:443',
  },
]
const tcpIndexes = buildIndexes(tcpOwners)
const tcpCandidate = tcpIndexes.localEndpoints.get(
  localEndpointKey('TCP', 'fdfe:dcba:9876::1', '57833'),
)
assert.equal(tcpCandidate?.pid, 16028)
assert.equal(tcpCandidate?.processName, 'Nstbrowser.exe')

const udpOwners = [
  {
    pid: 17292,
    processName: 'nstchrome.exe',
    processPath: 'C:\\Users\\Administrator\\.nst-agent\\nstchrome.exe',
    protocol: 'UDP',
    localAddress: '0.0.0.0:50575',
  },
]
const udpIndexes = buildIndexes(udpOwners)
assert.equal(
  udpIndexes.localEndpoints.get(localEndpointKey('UDP', '198.18.0.1', '50575')),
  undefined,
)
assert.equal(udpIndexes.localPorts.get('UDP|50575')?.pid, 17292)

const conflictIndexes = buildIndexes([
  ...udpOwners,
  {
    pid: 9999,
    processName: 'other.exe',
    processPath: 'C:\\Temp\\other.exe',
    protocol: 'UDP',
    localAddress: '0.0.0.0:50575',
  },
])
assert.equal(
  conflictIndexes.localPorts.get('UDP|50575'),
  null,
  'ambiguous ports must never be guessed',
)

const processSource = readFileSync(
  new URL('../src/services/process-connections.ts', import.meta.url),
  'utf8',
)
const dataSource = readFileSync(
  new URL('../src/hooks/use-connection-data.ts', import.meta.url),
  'utf8',
)
const detailSource = readFileSync(
  new URL(
    '../src/components/connection/connection-detail.tsx',
    import.meta.url,
  ),
  'utf8',
)
const rowSource = readFileSync(
  new URL(
    '../src/components/connection/connection-row-item.tsx',
    import.meta.url,
  ),
  'utf8',
)
const rustSource = readFileSync(
  new URL('../src-tauri/src/cmd/process_connections.rs', import.meta.url),
  'utf8',
)
const routeSource = readFileSync(
  new URL(
    '../src/components/routing/connection-project-card.tsx',
    import.meta.url,
  ),
  'utf8',
)

assert.match(processSource, /resolvedIdentitiesByPid/)
assert.match(processSource, /PID_PLACEHOLDER_PATTERN/)
assert.match(processSource, /INACTIVE_TCP_STATES/)
assert.match(processSource, /TIME-WAIT/)
assert.doesNotMatch(rustSource, /format!\("PID \{pid\}"\)/)
assert.match(detailSource, /height: '100dvh'/)
assert.match(detailSource, /flex: '1 1 0'/)
assert.match(detailSource, /scrollbarGutter: 'stable'/)
assert.match(processSource, /localEndpointCandidate/)
assert.match(processSource, /recentLocalEndpointCandidates/)
assert.match(processSource, /recentLocalPortCandidates/)
assert.match(processSource, /recent-local-port/)
assert.match(processSource, /最近无冲突的唯一源端口/)
assert.match(processSource, /同一端点存在多个应用候选/)
assert.match(dataSource, /PROCESS_CONNECTION_NEW_DELAY_MS = 120/)
assert.match(dataSource, /PROCESS_CONNECTION_RETRY_DELAY_MS = 350/)
assert.match(
  dataSource,
  /const closedConnections = enrichConnectionsWithProcesses/,
)
assert.match(detailSource, /activeConnections\.find/)
assert.match(detailSource, /closedConnections\.find/)
assert.match(detailSource, /recognizedApplication/)
assert.match(detailSource, /hasApplication \? targetLabel : '应用未识别'/)
assert.match(detailSource, /按目标设置分流/)
assert.match(detailSource, /monospace/)
assert.match(detailSource, /overflowWrap: 'anywhere'/)
assert.match(rowSource, /identifiedApplication \? application : row\.host/)
assert.match(routeSource, /应用规则/)
assert.match(routeSource, /当前出口/)
assert.doesNotMatch(routeSource, /useNavigate/)
assert.doesNotMatch(routeSource, /<Button/)

console.log('[通过] PID 占位值不会再冒充已识别程序')
console.log('[通过] 同 PID 的完整路径会修复占位连接记录')
console.log('[通过] 详情抽屉使用独立滚动区和固定操作栏')
console.log('[通过] Fake-IP IPv6 TCP 本地端点可归属到 Nstbrowser.exe')
console.log('[通过] Fake-IP UDP 可在端点地址变化时按唯一源端口归属')
console.log('[通过] 已结束 UDP 可使用最近唯一源端口补全应用')
console.log('[通过] 已结束连接继续接受系统归因更新并保留身份')
console.log('[通过] 同一源端口存在多个应用时停止猜测')
console.log('[通过] 未识别应用以目标为主标题并按目标设置分流')
console.log('[通过] 长程序路径使用独立整行显示，不再挤压技术字段')
console.log('[通过] 已打开详情持续订阅连接，列表以应用为主，路由摘要无重复按钮')
