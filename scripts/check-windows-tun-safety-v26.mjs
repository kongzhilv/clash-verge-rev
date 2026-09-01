import { readFile } from 'node:fs/promises'

import './check-windows-hotspot-zero-owner-v26.mjs'

const files = {
  entrypoint: 'scripts/check-windows-tun-safety.mjs',
  manager: 'src-tauri/src/core/manager/config.rs',
  lifecycle: 'src-tauri/src/core/manager/lifecycle.rs',
  windowsNetwork: 'src-tauri/src/utils/windows_network.rs',
  windowsManagedInterface: 'src-tauri/src/utils/windows_managed_interface.rs',
  windowsTopologyDiagnostics:
    'src-tauri/src/core/windows_network_diagnostics.rs',
  hotspot: 'src-tauri/src/core/windows_hotspot_ics.rs',
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

// The unversioned release entrypoint must certify the current v26 contract.
requireText(
  'entrypoint',
  "await import('./check-windows-tun-safety-v26.mjs')",
  'current Windows TUN safety entrypoint delegates to v26',
)
forbidText(
  'entrypoint',
  "check-windows-tun-safety-v24.mjs",
  'current Windows TUN safety entrypoint must not certify stale v24 semantics',
)

// Core lifecycle and authoritative Runtime regeneration remain unchanged.
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
    'managed-physical-interface-lease-applied',
    'managed all-outbound physical interface lease remains observable',
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
])
  requireText(
    'windowsNetwork',
    api,
    `Windows route guard uses native IP Helper API ${api}`,
  )

for (const [marker, label] of [
  ['const STABLE_SAMPLES: usize = 6;', 'physical upstream requires stable samples'],
  ['const MAX_SAMPLES: usize = 24;', 'physical upstream stability check is bounded'],
  ['skip_as_source: row.SkipAsSource', 'address inventory retains SkipAsSource'],
  ['!address.skip_as_source', 'physical source rejects SkipAsSource addresses'],
  ['is_filter_component', 'derived Wi-Fi Direct/filter components are classified'],
  ['route-exclude-address', 'physical LAN CIDR stays outside TUN auto-route'],
  ['managed_physical_route_guards', 'Runtime guards derive from stable physical upstream'],
  [
    'route_signature_ignores_metric_churn_and_runtime_guards',
    'route stability ignores metric/runtime-guard churn',
  ],
  ['ManagedProxyBindingStats', 'managed proxy binding remains observable'],
  ['apply_managed_proxy_bindings', 'managed proxy binding remains applied'],
  [
    'managed_proxy_sockets_bind_to_stable_physical_interface',
    'proxy sockets bind to the stable physical interface',
  ],
  ['explicit_provider_binding_is_preserved', 'explicit provider bindings remain higher priority'],
  [
    'managed_upstream_preserves_user_strict_route',
    'user strict-route semantics remain preserved',
  ],
  [
    'wifi_direct_filter_components_are_not_managed_as_hotspot_interfaces',
    'Wi-Fi Direct filter components are rejected as physical upstreams',
  ],
])
  requireText('windowsNetwork', marker, label)

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
])
  forbidText(
    'windowsNetwork',
    forbidden,
    'Windows TUN safety remains native and identity-driven',
  )

// v26: physical forwarding is part of the stable upstream identity because
// Windows Mobile Hotspot enables IP forwarding on the physical adapter.
for (const marker of [
  'forwarding_enabled: bool',
  'connected_interface_state',
  'row.ForwardingEnabled',
  'apply_forwarding_safe_tun_route',
  'forwarding_safe_route_addresses',
  'Value::from("route-address")',
  'fake-ip-range',
  'windows_network_forwarding_safe_tun_routes_only_fake_ip_range',
  'windows_network_forwarding_safe_tun_uses_custom_fake_ip_range',
  'windows_network_forwarding_without_fake_ip_disables_global_auto_route',
  'windows_network_forwarding_change_changes_stable_route_signature',
])
  requireText(
    'windowsNetwork',
    marker,
    `forwarding-safe TUN invariant ${marker}`,
  )

// No fake-IP range means fail closed rather than installing a global TUN
// default route while Windows forwarding is active.
requireText(
  'windowsNetwork',
  'tun.insert(Value::from("auto-route"), Value::from(false));',
  'forwarding without fake-IP disables unsafe automatic default routing',
)

// All Mihomo outbound still receives one Runtime-managed physical interface lease.
requireText(
  'utils',
  'pub mod windows_managed_interface;',
  'managed physical interface module is compiled on Windows',
)
for (const [marker, label] of [
  ['apply_managed_physical_interface_lease', 'managed physical interface lease implementation exists'],
  ['config.insert(interface_key, Value::from(alias));', 'managed lease binds global Mihomo outbound interface'],
  [
    'tun.insert(Value::from("auto-detect-interface"), Value::from(false));',
    'application topology watcher remains the single upstream selector',
  ],
  ['explicit_user_interface_is_never_overwritten', 'explicit user interface binding is preserved'],
  [
    'managed_lease_binds_all_outbound_to_stable_physical_nic',
    'all outbound traffic uses the stable NIC lease',
  ],
  ['empty_detected_alias_does_not_create_a_broken_lease', 'empty interface cannot create a broken lease'],
])
  requireText('windowsManagedInterface', marker, label)

for (const marker of [
  'apply_managed_physical_interface_lease',
  'runtime-managed-stable-physical-upstream',
  'all-mihomo-outbound',
  'forwarding-safe-fake-ip-only',
  'topology-watcher-regenerate-runtime-on-upstream-or-forwarding-mode',
  '"route_address": string_list("route-address")',
])
  requireText(
    'manager',
    marker,
    `managed physical interface/forwarding lifecycle marker ${marker} is present`,
  )

// One IP Helper watcher owns Runtime routing refresh. Hotspot lifecycle itself
// stays Windows-owned; only a stable physical ForwardingEnabled transition can
// cause the forwarding-safe Runtime to be regenerated.
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
for (const api of [
  'NotifyIpInterfaceChange',
  'NotifyUnicastIpAddressChange',
  'NotifyRouteChange2',
])
  requireText(
    'windowsTopologyDiagnostics',
    api,
    `runtime topology monitor subscribes to ${api}`,
  )

for (const marker of [
  'topology-monitor-started',
  'topology-baseline',
  'topology-changed',
  'hotspot_present',
  'hotspot_subnets',
  'physical_upstream',
  'default_routes_changed',
  'physical_upstream_identity_changed',
  'forwarding_state_changed',
  'hotspot-observed-routing-mode-evaluation',
  'physical-forwarding-mode-changed',
  '"hotspot_events_can_trigger_core_refresh": "forwarding-mode-only"',
  'refresh-deferred-during-hotspot-transition',
  'refresh-deferred-upstream-still-settling',
  'refresh-requested',
  'refresh-succeeded',
  'refresh-failed',
  'confirm_physical_upstream',
  'struct PhysicalUpstreamIdentity',
  'const UPSTREAM_CONFIRM_SAMPLES: usize = 3;',
  'WATCHDOG_INTERVAL',
  'manager.update_config_forced().await',
  'windows_network_forwarding_change_changes_runtime_identity',
  'hotspot_state_change_does_not_change_runtime_upstream_identity',
  'route_metric_churn_does_not_change_runtime_upstream_identity',
  'real_physical_upstream_change_changes_runtime_identity',
  'tokio::task::spawn_blocking(capture_topology)',
])
  requireText(
    'windowsTopologyDiagnostics',
    marker,
    `v26 topology safety marker ${marker} is present`,
  )

for (const stale of [
  'hotspot-observed-no-core-refresh',
  'prevent-hotspot-tun-reload-feedback-loop',
  '"hotspot_events_can_trigger_core_refresh": false',
])
  forbidText(
    'windowsTopologyDiagnostics',
    stale,
    `v24 hotspot-never-refresh assumption is invalid under Windows forwarding ${stale}`,
  )

const forcedRefreshCount =
  source.windowsTopologyDiagnostics.match(/update_config_forced\(\)\.await/g)
    ?.length ?? 0
if (forcedRefreshCount !== 1)
  failures.push(
    `topology watcher must contain exactly one forced Runtime refresh call, found ${forcedRefreshCount}`,
  )

const physicalIdentityBlock = source.windowsTopologyDiagnostics.match(
  /struct PhysicalUpstreamIdentity \{[\s\S]*?\n\}/,
)?.[0]
if (!physicalIdentityBlock) {
  failures.push('PhysicalUpstreamIdentity block missing')
} else {
  for (const metric of ['route_metric', 'interface_metric', 'effective_metric'])
    if (physicalIdentityBlock.includes(metric))
      failures.push(`PhysicalUpstreamIdentity must ignore transient ${metric}`)
  if (!physicalIdentityBlock.includes('forwarding_enabled'))
    failures.push('PhysicalUpstreamIdentity must include forwarding_enabled')
}

// WinRT/Wi-Fi Direct Mobile Hotspot is Windows-owned. HNetCfg is legacy-only.
for (const marker of [
  'HotspotOwnership',
  'WindowsMobileHotspot',
  'LegacyHostedNetwork',
  'windows-owned-hotspot-no-hnetcfg-mutation',
  'hnetcfg_lease_allowed',
  'EVENT_E_ALL_SUBSCRIBERS_FAILED',
  'windows_network_windows_owned_wifi_direct_never_uses_hnetcfg',
  'windows_network_legacy_hosted_network_retains_hnetcfg_compatibility',
])
  requireText('hotspot', marker, `Windows-owned hotspot invariant ${marker}`)

for (const forbidden of [
  'NetworkOperatorTetheringManager',
  'StartTetheringAsync',
  'StopTetheringAsync',
  '192.168.137.',
])
  forbidText(
    'hotspot',
    forbidden,
    `Karing must not own WinRT Mobile Hotspot lifecycle/fixed subnet ${forbidden}`,
  )

// Existing outbound diagnostics remain available for field verification.
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
])
  requireText(
    'outboundDiagnostics',
    marker,
    `outbound diagnostics marker ${marker} is retained`,
  )

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
  console.error('Windows TUN/forwarding-safe v26 regression failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Windows TUN/forwarding-safe v26 regression passed.')
console.log(
  '[通过] Mobile Hotspot 生命周期与 Wi-Fi Direct HNetCfg 数据面保持 Windows 所有',
)
console.log(
  '[通过] 物理 ForwardingEnabled 纳入稳定 Runtime 身份，仅稳定变化触发一次 Runtime 重生成',
)
console.log(
  '[通过] Forwarding=true 时 auto-route 仅路由最终 fake-IP CIDR(s)，不安装 TUN 默认路由',
)
console.log('[通过] 非 fake-IP 配置 fail-closed 关闭 unsafe auto-route，避免宿主机回环黑洞')
console.log('[通过] Runtime 全 outbound 继续绑定稳定物理 NIC，用户显式 interface 配置优先')
console.log('[通过] 物理 LAN route guard、proxy/provider defense-in-depth 与 outbound diagnostics 保留')
console.log('[通过] HNetCfg 仅保留 legacy Hosted Network 兼容及持久 rollback/HRESULT 诊断')
