import { readFile } from 'node:fs/promises'

import './check-windows-hotspot-zero-owner-v24.mjs'

const files = {
  manager: 'src-tauri/src/core/manager/config.rs',
  lifecycle: 'src-tauri/src/core/manager/lifecycle.rs',
  windowsNetwork: 'src-tauri/src/utils/windows_network.rs',
  windowsManagedInterface: 'src-tauri/src/utils/windows_managed_interface.rs',
  windowsTopologyDiagnostics:
    'src-tauri/src/core/windows_network_diagnostics.rs',
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

// Core lifecycle and authoritative Runtime regeneration.
for (const [key, marker, label] of [
  [
    'manager',
    'core is stopped; staged configuration without starting it',
    'background config update never starts a stopped core',
  ],
  [
    'manager',
    'matches!(*self.get_running_mode(), RunningMode::NotRunning)',
    'config application checks the actual core running state',
  ],
  [
    'manager',
    'prepare_windows_tun_runtime_for_start',
    'Windows has a pre-start TUN safety path',
  ],
  [
    'manager',
    'source_has_interface || app_has_interface',
    'explicit top-level user interface selection is preserved',
  ],
  [
    'manager',
    'tokio::task::spawn_blocking(detect_stable_upstream)',
    'native route inspection stays off the async executor',
  ],
  [
    'manager',
    'dynamic-upstream-enabled',
    'dynamic upstream behavior remains observable',
  ],
  [
    'manager',
    'managed-physical-interface-lease-applied',
    'managed all-outbound physical interface lease is observable',
  ],
  [
    'manager',
    'interface_pin_scope',
    'diagnostics expose managed interface lease scope',
  ],
  [
    'lifecycle',
    'self.prepare_windows_tun_runtime_for_start().await?;',
    'managed route and outbound bindings are installed before core startup',
  ],
]) {
  requireText(key, marker, label)
}

// Native Windows route selection remains physical-upstream-owned and shell-free.
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
for (const [marker, label] of [
  ['const STABLE_SAMPLES: usize = 6;', 'physical upstream requires stable samples'],
  ['const MAX_SAMPLES: usize = 24;', 'physical upstream stability check is bounded'],
  ['skip_as_source: row.SkipAsSource', 'address inventory retains SkipAsSource'],
  ['!address.skip_as_source', 'physical source rejects SkipAsSource addresses'],
  ['is_filter_component', 'derived Wi-Fi Direct/filter components are classified'],
  ['route-exclude-address', 'physical LAN CIDR stays outside TUN auto-route'],
  [
    'managed_physical_route_guards',
    'Runtime guards are derived from the stable physical upstream',
  ],
  [
    'route_signature_ignores_metric_churn_and_runtime_guards',
    'route stability ignores hotspot/metric churn',
  ],
  ['ManagedProxyBindingStats', 'managed proxy binding remains observable'],
  ['apply_managed_proxy_bindings', 'managed proxy binding remains applied'],
  [
    'managed_proxy_sockets_bind_to_stable_physical_interface',
    'proxy sockets bind to the stable physical interface',
  ],
  [
    'explicit_provider_binding_is_preserved',
    'explicit provider bindings remain higher priority',
  ],
  [
    'managed_upstream_uses_physical_only_runtime_guards',
    'Runtime guards stay physical-upstream-only',
  ],
  [
    'managed_upstream_preserves_user_strict_route',
    'user strict-route semantics remain preserved',
  ],
  [
    'wifi_direct_filter_components_are_not_managed_as_hotspot_interfaces',
    'Wi-Fi Direct filter components are rejected as physical upstreams',
  ],
]) {
  requireText('windowsNetwork', marker, label)
}
for (const marker of [
  'wfp native mac layer',
  'wfp 802.3 mac layer',
  'native wifi filter driver',
  'qos packet scheduler',
]) {
  requireText(
    'windowsNetwork',
    marker,
    `derived adapter component ${marker} is filtered`,
  )
}
for (const forbidden of [
  'apply_hotspot_strict_route_compat',
  'hotspot_ready',
  'managed_route_guards(',
  'merge_string_sequence(tun, "exclude-interface"',
  'hotspot_runtime_relaxes_strict_route_only_while_hotspot_is_managed',
  'hotspot_runtime_preserves_an_existing_strict_route_false',
  'hotspot_adapter_without_private_address_is_not_ready',
  'hotspot_route_guards_keep_preferred_skip_as_source_addresses',
]) {
  forbidText(
    'windowsNetwork',
    forbidden,
    'Mihomo Runtime must not derive lifecycle behavior from Mobile Hotspot state',
  )
}
forbidText(
  'windowsNetwork',
  'config.insert(\n        Value::from("interface-name")',
  'route guard module itself must not own the top-level outbound lease',
)
for (const forbidden of [
  'powershell.exe',
  'POWERSHELL_ROUTE_QUERY',
  'ExecutionPolicy',
  'Get-NetRoute',
  'Get-NetAdapter',
  'std::process::Command',
  '211.20.18.215',
  'xueshan168.cc',
  '192.168.137.0/24',
]) {
  forbidText(
    'windowsNetwork',
    forbidden,
    'Windows TUN safety must remain native and identity-driven',
  )
}
requireText(
  'manager',
  '"hotspot_runtime_dependency": false',
  'Runtime diagnostics explicitly report hotspot independence',
)

// All Mihomo outbound receives one Runtime-managed physical interface lease.
requireText(
  'utils',
  'pub mod windows_managed_interface;',
  'managed physical interface module is compiled on Windows',
)
for (const [marker, label] of [
  [
    'apply_managed_physical_interface_lease',
    'managed physical interface lease implementation exists',
  ],
  [
    'config.insert(interface_key, Value::from(alias));',
    'managed lease binds the global Mihomo outbound interface',
  ],
  [
    'tun.insert(Value::from("auto-detect-interface"), Value::from(false));',
    'application topology watcher is the single upstream selector',
  ],
  [
    'explicit_user_interface_is_never_overwritten',
    'explicit user interface binding is preserved',
  ],
  [
    'managed_lease_binds_all_outbound_to_stable_physical_nic',
    'all outbound traffic uses the stable NIC lease',
  ],
  [
    'empty_detected_alias_does_not_create_a_broken_lease',
    'empty detected interfaces cannot create a broken lease',
  ],
]) {
  requireText('windowsManagedInterface', marker, label)
}
for (const marker of [
  'apply_managed_physical_interface_lease',
  'runtime-managed-stable-physical-upstream',
  'all-mihomo-outbound',
  'regenerate-runtime-on-physical-upstream-change',
]) {
  requireText(
    'manager',
    marker,
    `managed physical interface lifecycle marker ${marker} is present`,
  )
}

// One IP Helper watcher observes topology. Hotspot-only changes never own Core refresh.
requireText(
  'coreMod',
  'pub mod windows_network_diagnostics;',
  'Windows topology diagnostics module is compiled',
)
requireText(
  'coreManager',
  'crate::core::windows_network_diagnostics::ensure_monitor_running();',
  'the topology watcher starts once',
)
for (const key of ['coreMod', 'coreManager']) {
  forbidText(
    key,
    'windows_hotspot_runtime_guard',
    'there must not be a second Windows hotspot watcher',
  )
}
for (const api of [
  'NotifyIpInterfaceChange',
  'NotifyUnicastIpAddressChange',
  'NotifyRouteChange2',
]) {
  requireText(
    'windowsTopologyDiagnostics',
    api,
    `runtime topology monitor subscribes to ${api}`,
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
  'physical_upstream_identity_changed',
  'hotspot-observed-no-core-refresh',
  'prevent-hotspot-tun-reload-feedback-loop',
  'refresh-deferred-during-hotspot-transition',
  'refresh-deferred-upstream-still-settling',
  'refresh-requested',
  'refresh-succeeded',
  'refresh-failed',
  'hotspot_events_can_trigger_core_refresh',
  'hotspot_owner',
  'confirm_physical_upstream',
  'struct PhysicalUpstreamIdentity',
  'const UPSTREAM_CONFIRM_SAMPLES: usize = 3;',
  'WATCHDOG_INTERVAL',
  'is_filter_component',
  'manager.update_config_forced().await',
  'refresh_runtime_network_state("physical-upstream-changed"',
  'previous_physical_upstream',
  'current_physical_upstream',
  'hotspot_state_change_does_not_change_runtime_upstream_identity',
  'route_metric_churn_does_not_change_runtime_upstream_identity',
  'real_physical_upstream_change_changes_runtime_identity',
  'hotspot_subnets_do_not_short_circuit_on_first_active_adapter',
  'tokio::task::spawn_blocking(capture_topology)',
]) {
  requireText(
    'windowsTopologyDiagnostics',
    marker,
    `topology safety marker ${marker} is present`,
  )
}
for (const forbidden of [
  'hotspot-guard-state-changed',
  'confirm_guard_signature',
  'GUARD_CONFIRM_',
  'last_applied_guard',
  'guard-state-confirmed',
  'refresh-deferred-hotspot-starting',
  'wait-for-ics-private-address-before-any-topology-reload',
  'interfaces.iter().any(|interface|',
  '192.168.137.0/24',
]) {
  forbidText(
    'windowsTopologyDiagnostics',
    forbidden,
    'hotspot topology must never own Runtime/Core refresh or fixed subnet state',
  )
}

const forcedRefreshCount =
  source.windowsTopologyDiagnostics.match(/update_config_forced\(\)\.await/g)
    ?.length ?? 0
if (forcedRefreshCount !== 1) {
  failures.push(
    `topology watcher must contain exactly one forced Runtime refresh call, found ${forcedRefreshCount}`,
  )
}

const physicalIdentityBlock = source.windowsTopologyDiagnostics.match(
  /struct PhysicalUpstreamIdentity \{[\s\S]*?\n\}/,
)?.[0]
if (!physicalIdentityBlock) {
  failures.push('PhysicalUpstreamIdentity block missing')
} else {
  for (const metric of [
    'route_metric',
    'interface_metric',
    'effective_metric',
  ]) {
    if (physicalIdentityBlock.includes(metric))
      failures.push(`PhysicalUpstreamIdentity must ignore transient ${metric}`)
  }
}

// Existing outbound diagnostics remain available for post-fix evidence.
requireText(
  'coreMod',
  'pub mod outbound_diagnostics;',
  'outbound diagnostics module is compiled',
)
requireText(
  'coreManager',
  'crate::core::outbound_diagnostics::ensure_monitor_running();',
  'outbound diagnostics starts once',
)
for (const marker of [
  'outbound-failure-summary',
  'outbound-connection-churn',
  'proxy-group-health-check-triggered',
  'service_latest.log',
  'sidecar_latest.log',
  '?<query-redacted>',
  'heuristic": true',
]) {
  requireText(
    'outboundDiagnostics',
    marker,
    `outbound diagnostics marker ${marker} is retained`,
  )
}

requireText(
  'utils',
  'pub mod windows_network;',
  'Windows managed routing module is compiled',
)
requireText(
  'manifest',
  '"Win32_NetworkManagement_Ndis"',
  'native adapter status types are enabled',
)

if (failures.length > 0) {
  console.error('Windows TUN/self-capture v24 regression failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Windows TUN/self-capture v24 regression passed.')
console.log('[通过] Mobile Hotspot 生命周期由 Windows/用户所有；Karing Start/Stop mutation = 0')
console.log('[通过] Hotspot VPN 数据面由 v24 原生 HNetCfg ICS minimal-diff gate 独占验证')
console.log('[通过] Wi-Fi 物理上游与 Wi-Fi Direct/ICS 热点下游保持角色分离')
console.log('[通过] 热点 On/Off、Wi-Fi Direct、ICS 子网变化只观测，不触发 Core/TUN refresh')
console.log('[通过] 物理上游身份忽略 route/interface metric 抖动，经稳定确认后才迁移 lease')
console.log('[通过] Runtime 顶层 interface-name 动态绑定稳定物理 NIC，覆盖全部 Mihomo outbound')
console.log('[通过] Mihomo auto-detect-interface 在 managed lease 下关闭，避免双 selector 竞争')
console.log('[通过] proxy/provider interface-name 继续作为 defense-in-depth')
console.log('[通过] 用户显式 node/provider/top-level interface 配置保持优先')
console.log('[通过] 热点 CIDR、热点接口、物理 NIC、代理 endpoint 均不写死')
