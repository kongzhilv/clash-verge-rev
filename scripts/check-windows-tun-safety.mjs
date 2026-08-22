import { readFile } from 'node:fs/promises'

const files = {
  manager: 'src-tauri/src/core/manager/config.rs',
  lifecycle: 'src-tauri/src/core/manager/lifecycle.rs',
  windowsNetwork: 'src-tauri/src/utils/windows_network.rs',
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
  'top_level_interface_pinned',
  'diagnostics still expose accidental top-level pinning',
)
requireText(
  'lifecycle',
  'self.prepare_windows_tun_runtime_for_start().await?;',
  'managed route and proxy bindings are installed before core startup',
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
  'Mihomo physical route auto detection remains enabled',
)
requireText(
  'windowsNetwork',
  'route_exclude_addresses.join(",")',
  'route stability signature includes dynamic LAN/hotspot exclusions',
)
forbidText(
  'windowsNetwork',
  'config.insert(\n        Value::from("interface-name")',
  'managed Windows TUN must not pin the top-level outbound interface',
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

// v2.5.4-karing.17: proactively bind Mihomo proxy sockets to the stable
// physical NIC, while preserving user bindings.
requireText(
  'windowsNetwork',
  'ManagedProxyBindingStats',
  'managed proxy binding is observable and testable',
)
requireText(
  'windowsNetwork',
  'apply_managed_proxy_bindings',
  'managed proxy binding is part of Windows TUN preparation',
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
  'managed binding uses Mihomo interface-name without top-level pinning',
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
  'Rust regression keeps top-level route selection dynamic',
)

// v2.5.4-karing.18: Windows strict-route is a Runtime-only compatibility
// lease while a real hotspot private-side interface is active. The saved Clash
// configuration remains authoritative and is regenerated when the hotspot exits.
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
  'route.excluded_interfaces.is_empty()',
  'strict-route relaxation only activates when a real managed hotspot interface exists',
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

// Single topology watcher with an ICS-ready state machine.
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
  'physical_upstream_changed',
  'refresh-requested',
  'refresh-succeeded',
  'refresh-failed',
  'refresh-deferred-hotspot-starting',
  'guard-state-confirmed',
  'refresh-deferred-topology-still-settling',
]) {
  requireText(
    'windowsTopologyDiagnostics',
    marker,
    `runtime topology/state-machine marker ${marker} is present`,
  )
}
requireText(
  'windowsTopologyDiagnostics',
  'const GUARD_CONFIRM_SAMPLES: usize = 3;',
  'hotspot Ready/Off transitions need multiple confirming snapshots',
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
  'hotspot-adapter-up-without-private-subnet',
  'adapter Up without an ICS subnet is explicitly Starting, not Ready',
)
requireText(
  'windowsTopologyDiagnostics',
  'wait-for-ics-private-address-before-any-topology-reload',
  'half-initialized hotspot state suppresses all topology-driven reloads',
)
requireText(
  'windowsTopologyDiagnostics',
  'manager.update_config_forced().await',
  'confirmed topology regenerates authoritative Runtime before apply',
)
requireText(
  'windowsTopologyDiagnostics',
  '"physical-upstream-changed"',
  'managed proxy binding follows real physical upstream changes',
)
requireText(
  'windowsTopologyDiagnostics',
  'physical_interface_pinned": false',
  'runtime diagnostics make top-level pinning state explicit',
)
requireText(
  'windowsTopologyDiagnostics',
  'hotspot_guard_waits_for_ics_private_address',
  'Rust regression covers the Off -> Starting -> Ready boundary',
)
requireText(
  'windowsTopologyDiagnostics',
  'hotspot_guard_off_state_is_actionable_for_cleanup',
  'Rust regression covers stable hotspot shutdown cleanup',
)
requireText(
  'windowsTopologyDiagnostics',
  'hotspot_subnets_do_not_short_circuit_on_first_active_adapter',
  'Rust regression retains the .15 hotspot subnet fix',
)
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

// Existing outbound diagnostics remain available for regression evidence.
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
console.log('[通过] 热点 Adapter Up 但无 ICS 私网地址时不再 reload')
console.log('[通过] Starting 期间任何 topology-driven reload 都被抑制')
console.log('[通过] Ready/Off 热点状态需多次稳定采样后才刷新 Runtime')
console.log(
  '[通过] 未显式绑定的 proxy/provider 出站 socket 动态绑定稳定物理 NIC',
)
console.log('[通过] 热点 Ready 时仅在 Runtime 临时关闭 strict-route，保存配置不变并可自动恢复')
console.log('[通过] 用户显式 node/provider/interface 配置保持优先')
console.log('[通过] 顶层 interface-name 仍不固定，物理切网由运行期稳定探测跟随')
console.log('[通过] 热点 CIDR、接口名、代理 endpoint 均不写死')
