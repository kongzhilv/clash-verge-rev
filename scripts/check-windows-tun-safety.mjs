import { readFile } from 'node:fs/promises'

const files = {
  manager: 'src-tauri/src/core/manager/config.rs',
  lifecycle: 'src-tauri/src/core/manager/lifecycle.rs',
  windowsNetwork: 'src-tauri/src/utils/windows_network.rs',
  windowsTopologyDiagnostics:
    'src-tauri/src/core/windows_network_diagnostics.rs',
  windowsHotspotGuard:
    'src-tauri/src/core/windows_hotspot_runtime_guard.rs',
  outboundDiagnostics: 'src-tauri/src/core/outbound_diagnostics.rs',
  coreMod: 'src-tauri/src/core/mod.rs',
  coreManager: 'src-tauri/src/core/manager/mod.rs',
  manifest: 'src-tauri/Cargo.toml',
  utils: 'src-tauri/src/utils/mod.rs',
}

const source = Object.fromEntries(
  await Promise.all(
    Object.entries(files).map(async ([key, path]) => [
      key,
      await readFile(path, 'utf8'),
    ]),
  ),
)

const failures = []
const requireText = (key, text, label) => {
  if (!source[key].includes(text)) failures.push(`${label}: missing ${text}`)
}
const forbidText = (key, text, label) => {
  if (source[key].includes(text))
    failures.push(`${label}: still contains ${text}`)
}

requireText(
  'manager',
  'core is stopped; staged configuration without starting it',
  'background config updates do not silently start a stopped proxy core',
)
requireText(
  'manager',
  'matches!(*self.get_running_mode(), RunningMode::NotRunning)',
  'config application checks the actual core running state',
)
requireText(
  'manager',
  'prepare_windows_tun_runtime_for_start',
  'Windows has a dedicated pre-start TUN safety path',
)
requireText(
  'manager',
  'source_has_interface || app_has_interface',
  'explicit user interface selection is preserved',
)
requireText(
  'manager',
  'tokio::task::spawn_blocking(detect_stable_upstream)',
  'native Windows route inspection does not block the async runtime',
)
requireText(
  'manager',
  'dynamic-upstream-enabled',
  'managed Windows TUN records that runtime outbound selection remains dynamic',
)
requireText(
  'manager',
  'top_level_interface_pinned',
  'diagnostics make stale-interface pinning directly observable',
)
requireText(
  'lifecycle',
  'self.prepare_windows_tun_runtime_for_start().await?;',
  'stable upstream validation happens before core startup',
)
requireText(
  'windowsNetwork',
  'const STABLE_SAMPLES: usize = 6;',
  'route selection requires a quiet stability window',
)
requireText(
  'windowsNetwork',
  'const MAX_SAMPLES: usize = 24;',
  'route selection has a bounded retry window',
)
for (const api of [
  'GetIpForwardTable2',
  'GetIfTable2',
  'GetUnicastIpAddressTable',
  'GetIpInterfaceEntry',
  'FreeMibTable',
]) {
  requireText(
    'windowsNetwork',
    api,
    `Windows route guard uses native IP Helper API ${api}`,
  )
}
requireText(
  'manifest',
  '"Win32_NetworkManagement_Ndis"',
  'native adapter status types are enabled without shelling out',
)
requireText(
  'windowsNetwork',
  'is_hotspot_side',
  'Windows hotspot private-side interfaces are identified',
)
requireText(
  'windowsNetwork',
  'wi-fi direct virtual adapter',
  'Wi-Fi Direct hotspot adapters are classified without locale-specific commands',
)
requireText(
  'windowsNetwork',
  'route-exclude-address',
  'LAN and hotspot subnets are protected from TUN auto-route',
)
requireText(
  'windowsNetwork',
  'exclude-interface',
  'hotspot-side interfaces can be excluded from TUN routing',
)
requireText(
  'windowsNetwork',
  'include-interface',
  'explicit include-interface is preserved to avoid conflicting Mihomo options',
)
forbidText(
  'windowsNetwork',
  'config.insert(\n        Value::from("interface-name")',
  'automatic Windows TUN must not pin the top-level outbound interface to the adapter seen at startup',
)
requireText(
  'windowsNetwork',
  'Value::from("auto-detect-interface"), Value::from(true)',
  'managed Windows TUN keeps Mihomo interface auto-detection enabled for reconnect and failover',
)
requireText(
  'windowsNetwork',
  'managed_upstream_keeps_dynamic_interface_and_protects_lan_and_hotspot_routes',
  'Rust regression explicitly covers dynamic outbound selection plus LAN/hotspot guards',
)
requireText(
  'windowsNetwork',
  'route_exclude_addresses.join(",")',
  'stability signature includes hotspot and LAN exclusions',
)
requireText(
  'utils',
  'pub mod windows_network;',
  'Windows route guard is compiled into the app',
)

for (const forbidden of [
  'powershell.exe',
  'POWERSHELL_ROUTE_QUERY',
  'ExecutionPolicy',
  'Get-NetRoute',
  'Get-NetAdapter',
  'std::process::Command',
]) {
  forbidText(
    'windowsNetwork',
    forbidden,
    'Windows TUN safety must not spawn PowerShell or depend on shell cmdlets',
  )
}

requireText(
  'coreMod',
  'pub mod outbound_diagnostics;',
  'outbound failure diagnostics module is compiled into the core',
)
requireText(
  'coreManager',
  'crate::core::outbound_diagnostics::ensure_monitor_running();',
  'outbound diagnostics monitor starts once with CoreManager initialization',
)
for (const marker of [
  'outbound-failure-summary',
  'outbound-connection-churn',
  'proxy-group-health-check-triggered',
]) {
  requireText(
    'outboundDiagnostics',
    marker,
    `structured outbound diagnostic event ${marker} is present`,
  )
}
requireText(
  'outboundDiagnostics',
  'RunningMode::Service',
  'outbound diagnostics covers service mode logs',
)
requireText(
  'outboundDiagnostics',
  'service_latest.log',
  'service mode diagnostics tails the service rolling log',
)
requireText(
  'outboundDiagnostics',
  'RunningMode::Sidecar',
  'outbound diagnostics covers sidecar mode logs',
)
requireText(
  'outboundDiagnostics',
  'sidecar_latest.log',
  'sidecar mode diagnostics tails the sidecar rolling log',
)
requireText(
  'outboundDiagnostics',
  'tokio::fs::read_to_string',
  'outbound diagnostics tails logs without blocking the async runtime',
)
requireText(
  'outboundDiagnostics',
  'MAX_DIMENSION_VALUES',
  'outbound diagnostic aggregation has a bounded cardinality',
)
requireText(
  'outboundDiagnostics',
  'SAMPLE_ERROR_MAX_CHARS',
  'outbound diagnostic error samples are length bounded',
)
requireText(
  'outboundDiagnostics',
  '?<query-redacted>',
  'outbound diagnostic error samples redact URL query strings',
)
requireText(
  'outboundDiagnostics',
  'heuristic": true',
  'connection churn is explicitly marked as a heuristic rather than a proven failure',
)

requireText(
  'coreMod',
  'pub mod windows_network_diagnostics;',
  'Windows runtime topology diagnostics module is compiled into the core',
)
requireText(
  'coreManager',
  'crate::core::windows_network_diagnostics::ensure_monitor_running();',
  'Windows runtime topology diagnostics starts once with CoreManager initialization',
)
for (const api of [
  'NotifyIpInterfaceChange',
  'NotifyUnicastIpAddressChange',
  'NotifyRouteChange2',
]) {
  requireText(
    'windowsTopologyDiagnostics',
    api,
    `Windows runtime topology monitor subscribes to ${api}`,
  )
}
for (const marker of [
  'topology-monitor-started',
  'topology-baseline',
  'topology-changed',
  'hotspot_present',
  'hotspot_subnets',
  'physical_upstream',
  'default_routes_changed',
  'physical_upstream_changed',
]) {
  requireText(
    'windowsTopologyDiagnostics',
    marker,
    `Windows hotspot topology diagnostic marker ${marker} is present`,
  )
}
requireText(
  'windowsTopologyDiagnostics',
  'wi-fi direct virtual adapter',
  'runtime topology diagnostics recognizes Wi-Fi Direct hotspot adapters',
)
requireText(
  'windowsTopologyDiagnostics',
  'WATCHDOG_INTERVAL',
  'runtime topology diagnostics has a bounded low-frequency notification fallback',
)
requireText(
  'windowsTopologyDiagnostics',
  'tokio::task::spawn_blocking(capture_topology)',
  'runtime topology snapshots do not block the async runtime',
)

requireText(
  'coreMod',
  'pub mod windows_hotspot_runtime_guard;',
  'Windows runtime hotspot guard module is compiled into the core',
)
requireText(
  'coreManager',
  'crate::core::windows_hotspot_runtime_guard::ensure_monitor_running();',
  'Windows runtime hotspot guard starts once with CoreManager initialization',
)
for (const api of ['NotifyIpInterfaceChange', 'NotifyUnicastIpAddressChange']) {
  requireText(
    'windowsHotspotGuard',
    api,
    `runtime hotspot guard subscribes to native ${api}`,
  )
}
for (const marker of [
  'hotspot-signature-changed',
  'refresh-requested',
  'refresh-succeeded',
  'refresh-failed',
]) {
  requireText(
    'windowsHotspotGuard',
    marker,
    `runtime hotspot guard diagnostic marker ${marker} is present`,
  )
}
requireText(
  'windowsHotspotGuard',
  'manager.update_config_forced().await',
  'hotspot changes regenerate the authoritative runtime before managed guards are recomputed',
)
requireText(
  'windowsHotspotGuard',
  'physical_interface_pinned": false',
  'runtime hotspot refresh explicitly preserves dynamic physical upstream selection',
)
requireText(
  'windowsHotspotGuard',
  'is_filter_component',
  'Wi-Fi Direct WFP/QoS/filter components are separated from the real hotspot adapter',
)
for (const marker of [
  'wfp native mac layer',
  'wfp 802.3 mac layer',
  'native wifi filter driver',
  'qos packet scheduler',
]) {
  requireText(
    'windowsHotspotGuard',
    marker,
    `runtime hotspot guard ignores derived adapter component ${marker}`,
  )
}
forbidText(
  'windowsHotspotGuard',
  '192.168.137.0/24',
  'runtime hotspot guard must derive the ICS subnet instead of hardcoding the common Windows hotspot CIDR',
)
requireText(
  'windowsHotspotGuard',
  'ipv4_cidr(address.address, address.prefix_length)',
  'runtime hotspot subnet is derived from the actual interface address and prefix',
)
requireText(
  'windowsHotspotGuard',
  'current == previous',
  'runtime hotspot refresh is idempotent and only runs when the hotspot signature changes',
)

if (failures.length > 0) {
  console.error('Windows TUN and outbound diagnostics regression failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Windows TUN and outbound diagnostics regression passed.')
console.log('[通过] 启动阶段不再执行 PowerShell / ExecutionPolicy Bypass')
console.log('[通过] 默认路由通过 Win32 IP Helper API 在进程内读取')
console.log('[通过] Wi-Fi Direct/移动热点私网接口与 LAN CIDR 受 TUN 路由保护')
console.log(
  '[通过] TUN 不再钉死启动时物理网卡，断网恢复/切网继续由 Mihomo 动态跟随出口',
)
console.log(
  '[通过] Service/Sidecar 出站失败、健康检查与短时连接抖动进入有界结构化诊断',
)
console.log(
  '[通过] 出站错误样本限制长度并移除 URL query，连接抖动明确标记为 heuristic',
)
console.log(
  '[通过] Windows 运行期接口/IP/路由与 Wi-Fi Direct 热点拓扑变化进入结构化诊断',
)
console.log(
  '[通过] 移动热点开关/IP 变化会从权威配置重生成 Runtime 并动态重算 TUN guard，不写死物理出口或 ICS 网段',
)
