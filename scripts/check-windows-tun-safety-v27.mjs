import { readFile } from 'node:fs/promises'

const files = {
  entrypoint: 'scripts/check-windows-tun-safety.mjs',
  manager: 'src-tauri/src/core/manager/config.rs',
  lifecycle: 'src-tauri/src/core/manager/lifecycle.rs',
  windowsNetwork: 'src-tauri/src/utils/windows_network.rs',
  windowsManagedInterface: 'src-tauri/src/utils/windows_managed_interface.rs',
  windowsTopologyDiagnostics: 'src-tauri/src/core/windows_network_diagnostics.rs',
  hotspot: 'src-tauri/src/core/windows_hotspot_ics_v27.rs',
  coreMod: 'src-tauri/src/core/mod.rs',
  coreManager: 'src-tauri/src/core/manager/mod.rs',
  manifest: 'src-tauri/Cargo.toml',
  utils: 'src-tauri/src/utils/mod.rs',
}

const source = Object.fromEntries(
  await Promise.all(
    Object.entries(files).map(async ([key, path]) => [key, await readFile(path, 'utf8')]),
  ),
)

const failures = []
const requireText = (key, text, label) => {
  if (!source[key].includes(text)) failures.push(`${label}: missing ${text}`)
}
const forbidText = (key, text, label) => {
  if (source[key].includes(text)) failures.push(`${label}: still contains ${text}`)
}

requireText(
  'entrypoint',
  "await import('./check-windows-tun-safety-v27.mjs')",
  'current Windows TUN safety entrypoint delegates to v27',
)
requireText(
  'coreMod',
  '#[path = "windows_hotspot_ics_v27.rs"]',
  'runtime activates the v27 Mobile Hotspot ICS implementation',
)

// Preserve the mature v26 host-route invariants: native-only discovery, bounded
// topology stabilization, physical upstream ownership and forwarding-safe TUN
// routing. v27 must add hotspot compatibility without weakening these guards.
for (const [key, marker, label] of [
  ['manager', 'prepare_windows_tun_runtime_for_start', 'pre-start Windows TUN safety remains active'],
  ['manager', 'tokio::task::spawn_blocking(detect_stable_upstream)', 'native route inspection stays off the async executor'],
  ['manager', 'managed-physical-interface-lease-applied', 'managed physical interface lease remains observable'],
  ['lifecycle', 'self.prepare_windows_tun_runtime_for_start().await?;', 'route/outbound bindings are installed before core startup'],
  ['windowsNetwork', 'GetIpForwardTable2', 'native route inventory remains enabled'],
  ['windowsNetwork', 'GetIfTable2', 'native interface inventory remains enabled'],
  ['windowsNetwork', 'GetUnicastIpAddressTable', 'native address inventory remains enabled'],
  ['windowsNetwork', 'GetIpInterfaceEntry', 'native forwarding state remains enabled'],
  ['windowsNetwork', 'const STABLE_SAMPLES: usize = 6;', 'physical upstream requires stable samples'],
  ['windowsNetwork', 'const MAX_SAMPLES: usize = 24;', 'physical upstream stabilization stays bounded'],
  ['windowsNetwork', 'apply_forwarding_safe_tun_route', 'forwarding-safe TUN route policy remains active'],
  ['windowsNetwork', 'forwarding_safe_route_addresses', 'forwarding-safe route addresses remain derived'],
  ['windowsNetwork', 'fake-ip-range', 'fake-IP range remains config-derived'],
  ['windowsNetwork', 'tun.insert(Value::from("auto-route"), Value::from(false));', 'non-fake-IP forwarding fails closed'],
  ['windowsManagedInterface', 'apply_managed_physical_interface_lease', 'physical interface lease remains active'],
  ['windowsManagedInterface', 'explicit_user_interface_is_never_overwritten', 'explicit user interface binding remains authoritative'],
  ['windowsTopologyDiagnostics', 'NotifyIpInterfaceChange', 'topology watcher tracks interface changes'],
  ['windowsTopologyDiagnostics', 'NotifyUnicastIpAddressChange', 'topology watcher tracks address changes'],
  ['windowsTopologyDiagnostics', 'NotifyRouteChange2', 'topology watcher tracks route changes'],
  ['windowsTopologyDiagnostics', 'confirm_physical_upstream', 'runtime refresh reconfirms upstream'],
  ['windowsTopologyDiagnostics', 'forwarding_state_changed', 'forwarding changes remain observable'],
  ['coreManager', 'crate::core::windows_network_diagnostics::ensure_monitor_running();', 'topology watcher starts once'],
]) {
  requireText(key, marker, label)
}

for (const forbidden of [
  'powershell.exe',
  'POWERSHELL_ROUTE_QUERY',
  'ExecutionPolicy',
  'Get-NetRoute',
  'Get-NetAdapter',
  'std::process::Command',
  '192.168.137.0/24',
]) {
  forbidText('windowsNetwork', forbidden, 'host TUN safety remains native and identity-driven')
}

// v27 compatibility topology. Runtime identity is GUID-based and the observed
// adapter aliases are diagnostics only; no SSID, ifIndex or hotspot subnet is a
// behavioral input. Ambiguous discovery must fail closed.
for (const [marker, label] of [
  ['GetIfTable2', 'adapter inventory uses native IP Helper'],
  ['GetUnicastIpAddressTable', 'hotspot addressing uses native IP Helper'],
  ['InterfaceGuid', 'adapter identity is GUID based'],
  ['target-identification-ambiguous', 'ambiguous adapter discovery fails closed'],
  ['is_mobile_hotspot_adapter', 'modern Wi-Fi Direct/Mobile Hotspot is eligible'],
  ['is_windows_mobile_hotspot_identity', 'Windows-owned hotspot is tracked for safe restore'],
  ['NetworkInformation::GetInternetConnectionProfile', 'original upstream is captured dynamically'],
  ['NetworkAdapterId', 'original upstream is persisted by adapter GUID'],
  ['EnableSharing(ICSSHARINGTYPE_PRIVATE)', 'active hotspot is made ICS PRIVATE'],
  ['EnableSharing(ICSSHARINGTYPE_PUBLIC)', 'Mihomo TUN is made ICS PUBLIC'],
  ['save_snapshot', 'original ICS state is persisted before mutation'],
  ['snapshot.version != 2 && snapshot.version != 3', 'v20/v26 snapshots remain upgrade-readable'],
  ['restore dynamically captured Mobile Hotspot upstream as PUBLIC', 'hidden Windows hotspot state has a dynamic restore fallback'],
  ['preserve Windows Mobile Hotspot PRIVATE side during restore', 'Windows-owned hotspot is not torn down on restore'],
  ['restore_snapshot_unlocked', 'ICS state has a rollback path'],
  ['rollback-immediately', 'failed apply rolls back immediately'],
  ['lease_roles_are_desired', 'post-apply role readback is verified'],
  ['restore_now', 'shutdown/TUN-off explicit restore remains available'],
  ['const LOOP_INTERVAL: Duration = Duration::from_secs(2);', 'hotspot topology is monitored'],
  ['const STABLE_SAMPLES: u8 = 3;', 'hotspot topology changes require stable observations'],
  ['hardcoded_upstream_interface', 'diagnostics certify dynamic upstream behavior'],
  ['hardcoded_hotspot_subnet', 'diagnostics certify dynamic hotspot behavior'],
]) {
  requireText('hotspot', marker, label)
}

for (const forbidden of [
  'CMCC-303-5G',
  '192.168.137.0/24',
  '192.168.1.6',
  'ifIndex 23',
  'ifIndex 25',
  'ifIndex 55',
  'powershell.exe',
  'Get-NetAdapter',
  'Get-NetRoute',
  'std::process::Command',
  'hnetcfg_lease_allowed',
  'windows-owned-hotspot-no-hnetcfg-mutation',
  'expect("checked non-empty")',
]) {
  forbidText('hotspot', forbidden, 'v27 remains generic and release-safe')
}

requireText(
  'hotspot',
  'windows-hotspot-ics-lease-v20.json',
  'v27 reuses the existing persistent lease snapshot path',
)
requireText(
  'manifest',
  '"Networking_Connectivity"',
  'WinRT connectivity API needed for dynamic upstream GUID is enabled',
)
requireText('utils', 'pub mod windows_network;', 'Windows managed routing module remains compiled')

if (failures.length) {
  console.error('[windows-tun-safety-v27] FAILED')
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}

console.log('[windows-tun-safety-v27] OK')
console.log('[通过] 主机侧 v26 native route/forwarding-safe 不变量保留')
console.log('[通过] 现代 Mobile Hotspot 动态 GUID 识别并切换为 PRIVATE，Mihomo TUN 为 PUBLIC')
console.log('[通过] HNetCfg 初始隐藏热点角色时，按 preferred Internet adapter GUID 动态恢复上游')
console.log('[通过] 无 SSID / 固定 ifIndex / 固定热点子网 / PowerShell 路径')
console.log('[通过] 持久快照、readback、立即回滚、TUN/退出恢复与拓扑监察保留')
