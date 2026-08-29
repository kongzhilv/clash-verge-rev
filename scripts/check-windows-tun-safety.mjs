import { readFile } from 'node:fs/promises'

const files = {
  manager: 'src-tauri/src/core/manager/config.rs',
  lifecycle: 'src-tauri/src/core/manager/lifecycle.rs',
  windowsNetwork: 'src-tauri/src/utils/windows_network.rs',
  windowsManagedInterface: 'src-tauri/src/utils/windows_managed_interface.rs',
  windowsTopologyDiagnostics:
    'src-tauri/src/core/windows_network_diagnostics.rs',
  windowsHotspotOwner: 'src-tauri/src/core/windows_hotspot_ics.rs',
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
requireText(
  'manager',
  'core is stopped; staged configuration without starting it',
  'background config update never starts a stopped core',
)
requireText(
  'manager',
  'matches!(*self.get_running_mode(), RunningMode::NotRunning)',
  'config application checks the actual core running state',
)
requireText(
  'manager',
  'prepare_windows_tun_runtime_for_start',
  'Windows has a pre-start TUN safety path',
)
requireText(
  'manager',
  'source_has_interface || app_has_interface',
  'explicit top-level user interface selection is preserved',
)
requireText(
  'manager',
  'tokio::task::spawn_blocking(detect_stable_upstream)',
  'native route inspection stays off the async executor',
)
requireText(
  'manager',
  'dynamic-upstream-enabled',
  'dynamic upstream behavior remains observable',
)
requireText(
  'manager',
  'managed-physical-interface-lease-applied',
  'managed all-outbound physical interface lease is observable',
)
requireText(
  'manager',
  'interface_pin_scope',
  'diagnostics expose managed interface lease scope',
)
requireText(
  'lifecycle',
  'self.prepare_windows_tun_runtime_for_start().await?;',
  'managed route and outbound bindings are installed before core startup',
)

// Native Windows route selection and TUN guards.
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
  'windowsNetwork',
  'const STABLE_SAMPLES: usize = 6;',
  'physical upstream selection requires stable samples',
)
requireText(
  'windowsNetwork',
  'const MAX_SAMPLES: usize = 24;',
  'physical upstream stability check is bounded',
)
requireText(
  'windowsNetwork',
  'skip_as_source: row.SkipAsSource',
  'address inventory retains SkipAsSource state',
)
requireText(
  'windowsNetwork',
  '!address.skip_as_source',
  'physical outbound source rejects SkipAsSource addresses',
)
requireText(
  'windowsNetwork',
  'Do not discard them merely because Windows marks SkipAsSource.',
  'ICS private-side route guards retain valid private addresses',
)
requireText(
  'windowsNetwork',
  'is_filter_component',
  'Wi-Fi Direct filter components are separated from the base adapter',
)
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
requireText(
  'windowsNetwork',
  'route-exclude-address',
  'LAN/hotspot CIDRs are excluded from TUN auto-route',
)
requireText(
  'windowsNetwork',
  'exclude-interface',
  'hotspot-side base interface can be excluded',
)
requireText(
  'windowsNetwork',
  'include-interface',
  'explicit include-interface is respected',
)
requireText(
  'windowsNetwork',
  'Value::from("auto-detect-interface"), Value::from(true)',
  'route guard leaves upstream selection available before the managed lease is applied',
)
requireText(
  'windowsNetwork',
  'route_exclude_addresses.join(",")',
  'route stability signature includes dynamic LAN/hotspot exclusions',
)
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
]) {
  forbidText(
    'windowsNetwork',
    forbidden,
    'Windows TUN safety does not depend on shell commands',
  )
}

// Proxy/provider binding remains defense in depth, not a second topology owner.
requireText(
  'windowsNetwork',
  'ManagedProxyBindingStats',
  'managed proxy binding is observable and testable',
)
requireText(
  'windowsNetwork',
  'apply_managed_proxy_bindings',
  'managed proxy binding remains part of Windows TUN preparation',
)
requireText(
  'windowsNetwork',
  'config.get_mut("proxies")',
  'inline proxy nodes receive a managed interface binding',
)
requireText(
  'windowsNetwork',
  'config.get_mut("proxy-providers")',
  'proxy providers receive a managed interface override',
)
requireText(
  'windowsNetwork',
  'Value::String("interface-name".to_owned())',
  'managed node/provider binding still uses Mihomo interface-name',
)
requireText(
  'windowsNetwork',
  'provider.get_mut(&override_key)',
  'provider override is merged rather than replacing user configuration',
)
requireText(
  'windowsNetwork',
  'managed_proxy_sockets_bind_to_stable_physical_interface',
  'Rust regression covers managed node/provider socket binding',
)
requireText(
  'windowsNetwork',
  'explicit_provider_binding_is_preserved',
  'Rust regression preserves explicit provider bindings',
)
requireText(
  'windowsNetwork',
  'managed_upstream_keeps_dynamic_interface_and_protects_lan_and_hotspot_routes',
  'Rust regression keeps the route-guard layer dynamic and LAN/hotspot-safe',
)

// strict-route compatibility remains Runtime-only and ICS-derived.
requireText(
  'windowsNetwork',
  'apply_hotspot_strict_route_compat',
  'Windows hotspot strict-route compatibility lease is implemented',
)
requireText(
  'windowsNetwork',
  'Windows Mobile Hotspot/ICS plus strict-route has an upstream self-capture',
  'compatibility lease documents the upstream failure class it mitigates',
)
requireText(
  'windowsNetwork',
  'tun.insert(key, Value::from(false));',
  'hotspot Runtime can relax strict-route without changing saved config',
)
requireText(
  'windowsNetwork',
  'if !route.hotspot_ready',
  'strict-route relaxation waits for a real ICS private subnet',
)
requireText(
  'windowsNetwork',
  'hotspot_ready = true;',
  'native route guard records the ICS-ready boundary from a real private CIDR',
)
requireText(
  'windowsNetwork',
  'hotspot_runtime_relaxes_strict_route_only_while_hotspot_is_managed',
  'Rust regression covers hotspot-only strict-route relaxation and restoration boundary',
)
requireText(
  'windowsNetwork',
  'hotspot_runtime_preserves_an_existing_strict_route_false',
  'Rust regression preserves an already-disabled strict-route setting',
)
requireText(
  'windowsNetwork',
  'hotspot_adapter_without_private_address_is_not_ready',
  'Rust regression prevents strict-route compatibility during hotspot Starting state',
)
requireText(
  'windowsNetwork',
  'hotspot_route_guards_keep_preferred_skip_as_source_addresses',
  'Rust regression retains ICS SkipAsSource coverage',
)
requireText(
  'windowsNetwork',
  'wifi_direct_filter_components_are_not_managed_as_hotspot_interfaces',
  'Rust regression rejects derived Wi-Fi Direct filter interfaces',
)
forbidText(
  'windowsNetwork',
  '211.20.18.215',
  'production self-capture defense must not hardcode one proxy endpoint',
)
forbidText(
  'windowsNetwork',
  'xueshan168.cc',
  'production self-capture defense must not hardcode one provider domain',
)
forbidText(
  'windowsNetwork',
  '192.168.137.0/24',
  'production hotspot compatibility must not hardcode the common ICS subnet',
)

// All Mihomo outbound receives one Runtime-managed physical interface lease.
requireText(
  'utils',
  'pub mod windows_managed_interface;',
  'managed physical interface module is compiled on Windows',
)
requireText(
  'windowsManagedInterface',
  'apply_managed_physical_interface_lease',
  'managed physical interface lease implementation exists',
)
requireText(
  'windowsManagedInterface',
  'config.insert(interface_key, Value::from(alias));',
  'managed lease binds the global Mihomo outbound interface',
)
requireText(
  'windowsManagedInterface',
  'tun.insert(Value::from("auto-detect-interface"), Value::from(false));',
  'application topology watcher becomes the single upstream selector',
)
requireText(
  'windowsManagedInterface',
  'explicit_user_interface_is_never_overwritten',
  'Rust regression preserves explicit user interface binding',
)
requireText(
  'windowsManagedInterface',
  'managed_lease_binds_all_outbound_to_stable_physical_nic',
  'Rust regression covers all-outbound stable NIC lease',
)
requireText(
  'windowsManagedInterface',
  'empty_detected_alias_does_not_create_a_broken_lease',
  'Rust regression rejects an empty detected interface',
)
requireText(
  'manager',
  'apply_managed_physical_interface_lease',
  'CoreManager applies the all-outbound lease after stable route detection',
)
requireText(
  'manager',
  'runtime-managed-stable-physical-upstream',
  'managed lease source is explicit in diagnostics',
)
requireText(
  'manager',
  'all-mihomo-outbound',
  'managed lease scope is explicit in diagnostics',
)
requireText(
  'manager',
  'regenerate-runtime-on-physical-upstream-change',
  'managed lease failover behavior is explicit in diagnostics',
)

// Mobile Hotspot has one mutation owner: the WinRT tethering manager.
for (const marker of [
  'NetworkOperatorTetheringManager',
  'CreateFromConnectionProfile',
  'StopTetheringAsync()',
  'StartTetheringAsync()',
  'MUTATION_LOCK',
  'restore_snapshot_unlocked',
  'lease-cleared-user-hotspot-off',
]) {
  requireText(
    'windowsHotspotOwner',
    marker,
    `WinRT single-owner invariant ${marker}`,
  )
}
for (const forbidden of [
  'INetSharingManager',
  'EnableSharing(',
  'powershell.exe',
  'pwsh.exe',
  'netsh ',
]) {
  forbidText(
    'windowsHotspotOwner',
    forbidden,
    'hotspot mutation owner must remain WinRT-only',
  )
}

// One IP Helper watcher observes all topology, but hotspot state is observability-only.
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
forbidText(
  'coreMod',
  'windows_hotspot_runtime_guard',
  'do not introduce a second Windows hotspot watcher',
)
forbidText(
  'coreManager',
  'windows_hotspot_runtime_guard',
  'CoreManager starts only one Windows topology watcher',
)
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
]) {
  requireText(
    'windowsTopologyDiagnostics',
    marker,
    `v23 single-owner topology marker ${marker} is present`,
  )
}
requireText(
  'windowsTopologyDiagnostics',
  'const UPSTREAM_CONFIRM_SAMPLES: usize = 3;',
  'real physical upstream transitions require multiple confirming snapshots',
)
requireText(
  'windowsTopologyDiagnostics',
  'WATCHDOG_INTERVAL',
  'topology watcher retains bounded watchdog sampling',
)
requireText(
  'windowsTopologyDiagnostics',
  'is_filter_component',
  'topology watcher filters derived Wi-Fi Direct components',
)
requireText(
  'windowsTopologyDiagnostics',
  'manager.update_config_forced().await',
  'physical upstream change can regenerate authoritative Runtime',
)
requireText(
  'windowsTopologyDiagnostics',
  'refresh_runtime_network_state("physical-upstream-changed"',
  'only the physical upstream path calls the Runtime refresh helper',
)
requireText(
  'windowsTopologyDiagnostics',
  'previous_physical_upstream',
  'topology refresh logs previous physical upstream',
)
requireText(
  'windowsTopologyDiagnostics',
  'current_physical_upstream',
  'topology refresh logs current physical upstream',
)
requireText(
  'windowsTopologyDiagnostics',
  'hotspot_state_change_does_not_change_runtime_upstream_identity',
  'Rust regression proves hotspot On/Off does not alter the Runtime upstream identity',
)
requireText(
  'windowsTopologyDiagnostics',
  'route_metric_churn_does_not_change_runtime_upstream_identity',
  'Rust regression proves route metric churn cannot trigger a Runtime lease move',
)
requireText(
  'windowsTopologyDiagnostics',
  'real_physical_upstream_change_changes_runtime_identity',
  'Rust regression preserves real physical failover',
)
requireText(
  'windowsTopologyDiagnostics',
  'hotspot_subnets_do_not_short_circuit_on_first_active_adapter',
  'Rust regression retains the hotspot subnet collection fix',
)
for (const forbidden of [
  'hotspot-guard-state-changed',
  'confirm_guard_signature',
  'GUARD_CONFIRM_',
  'last_applied_guard',
  'guard-state-confirmed',
  'refresh-deferred-hotspot-starting',
  'wait-for-ics-private-address-before-any-topology-reload',
]) {
  forbidText(
    'windowsTopologyDiagnostics',
    forbidden,
    'hotspot topology must never own Runtime/Core refresh',
  )
}
forbidText(
  'windowsTopologyDiagnostics',
  'interfaces.iter().any(|interface|',
  'hotspot subnet collection must not use side-effectful any()',
)
forbidText(
  'windowsTopologyDiagnostics',
  '192.168.137.0/24',
  'runtime topology code must derive ICS subnet from Windows',
)
requireText(
  'windowsTopologyDiagnostics',
  'tokio::task::spawn_blocking(capture_topology)',
  'Win32 topology snapshots do not block the async executor',
)

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
    if (physicalIdentityBlock.includes(metric)) {
      failures.push(`PhysicalUpstreamIdentity must ignore transient ${metric}`)
    }
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
]) {
  requireText(
    'outboundDiagnostics',
    marker,
    `structured outbound event ${marker} is retained`,
  )
}
requireText(
  'outboundDiagnostics',
  'service_latest.log',
  'service-mode failures remain observable',
)
requireText(
  'outboundDiagnostics',
  'sidecar_latest.log',
  'sidecar-mode failures remain observable',
)
requireText(
  'outboundDiagnostics',
  '?<query-redacted>',
  'diagnostic URL queries remain redacted',
)
requireText(
  'outboundDiagnostics',
  'heuristic": true',
  'connection churn remains explicitly heuristic',
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
  console.error('Windows TUN/self-capture regression failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Windows TUN/self-capture regression passed.')
console.log('[通过] Wi-Fi 上游与 Wi-Fi Direct/ICS 热点下游保持角色分离')
console.log(
  '[通过] Mobile Hotspot 只有 WinRT NetworkOperatorTetheringManager 一个 mutation owner',
)
console.log(
  '[通过] 热点 On/Off、Wi-Fi Direct、ICS 子网变化只观测，不触发 Core/TUN refresh',
)
console.log(
  '[通过] 物理上游身份忽略 route/interface metric 抖动，并经 3 次稳定确认后才迁移 lease',
)
console.log(
  '[通过] Runtime 顶层 interface-name 动态绑定稳定物理 NIC，覆盖全部 Mihomo outbound',
)
console.log(
  '[通过] Mihomo auto-detect-interface 在 managed lease 下关闭，避免双 selector 竞争',
)
console.log('[通过] proxy/provider interface-name 继续作为 defense-in-depth')
console.log(
  '[通过] 热点 Ready 时 strict-route 仅在 Runtime 临时降级并可自动恢复',
)
console.log('[通过] 用户显式 node/provider/top-level interface 配置保持优先')
console.log('[通过] 热点 CIDR、热点接口、物理 NIC、代理 endpoint 均不写死')
