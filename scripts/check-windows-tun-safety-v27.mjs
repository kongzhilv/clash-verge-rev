import { readFile } from 'node:fs/promises'

const files = {
  entrypoint: 'scripts/check-windows-tun-safety.mjs',
  manager: 'src-tauri/src/core/manager/config.rs',
  lifecycle: 'src-tauri/src/core/manager/lifecycle.rs',
  windowsNetwork: 'src-tauri/src/utils/windows_network.rs',
  windowsManagedInterface: 'src-tauri/src/utils/windows_managed_interface.rs',
  windowsTopologyDiagnostics:
    'src-tauri/src/core/windows_network_diagnostics.rs',
  hotspot: 'src-tauri/src/core/windows_hotspot_ics_v27.rs',
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
const hotspotProduction = source.hotspot.split('\n#[cfg(test)]', 1)[0]
const failures = []

const requireText = (key, text, label) => {
  if (!source[key].includes(text)) failures.push(`${label}: missing ${text}`)
}

const forbidText = (text, label) => {
  if (hotspotProduction.includes(text)) {
    failures.push(`${label}: production code still contains ${text}`)
  }
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

for (const [key, marker, label] of [
  ['manager', 'prepare_windows_tun_runtime_for_start', 'pre-start TUN safety remains active'],
  [
    'manager',
    'tokio::task::spawn_blocking(detect_stable_upstream)',
    'native route inspection stays off the async executor',
  ],
  [
    'manager',
    'managed-physical-interface-lease-applied',
    'managed physical interface lease remains observable',
  ],
  [
    'lifecycle',
    'self.prepare_windows_tun_runtime_for_start().await?;',
    'route and outbound bindings are installed before core startup',
  ],
  ['windowsNetwork', 'GetIpForwardTable2', 'native route inventory remains enabled'],
  ['windowsNetwork', 'GetIfTable2', 'native interface inventory remains enabled'],
  [
    'windowsNetwork',
    'GetUnicastIpAddressTable',
    'native address inventory remains enabled',
  ],
  [
    'windowsNetwork',
    'GetIpInterfaceEntry',
    'native forwarding state remains enabled',
  ],
  [
    'windowsNetwork',
    'const STABLE_SAMPLES: usize = 6;',
    'physical upstream still requires stable samples',
  ],
  [
    'windowsNetwork',
    'const MAX_SAMPLES: usize = 24;',
    'physical upstream stabilization remains bounded',
  ],
  [
    'windowsNetwork',
    'apply_forwarding_safe_tun_route',
    'forwarding-safe TUN route policy remains active',
  ],
  [
    'windowsNetwork',
    'forwarding_safe_route_addresses',
    'forwarding-safe route addresses remain derived',
  ],
  ['windowsNetwork', 'fake-ip-range', 'fake-IP range remains config-derived'],
  [
    'windowsNetwork',
    'tun.insert(Value::from("auto-route"), Value::from(false));',
    'non-fake-IP forwarding remains fail-closed',
  ],
  [
    'windowsManagedInterface',
    'apply_managed_physical_interface_lease',
    'physical interface lease remains active',
  ],
  [
    'windowsManagedInterface',
    'explicit_user_interface_is_never_overwritten',
    'explicit user interface binding remains authoritative',
  ],
  [
    'windowsTopologyDiagnostics',
    'NotifyIpInterfaceChange',
    'topology watcher tracks interface changes',
  ],
  [
    'windowsTopologyDiagnostics',
    'NotifyUnicastIpAddressChange',
    'topology watcher tracks address changes',
  ],
  [
    'windowsTopologyDiagnostics',
    'NotifyRouteChange2',
    'topology watcher tracks route changes',
  ],
  [
    'windowsTopologyDiagnostics',
    'confirm_physical_upstream',
    'runtime refresh reconfirms upstream',
  ],
  [
    'windowsTopologyDiagnostics',
    'forwarding_state_changed',
    'forwarding changes remain observable',
  ],
  [
    'coreManager',
    'crate::core::windows_network_diagnostics::ensure_monitor_running();',
    'topology watcher starts once',
  ],
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
  if (source.windowsNetwork.includes(forbidden)) {
    failures.push(`host TUN safety remains native: still contains ${forbidden}`)
  }
}

for (const [marker, label] of [
  ['GetIfTable2', 'hotspot adapter inventory uses native IP Helper'],
  ['GetUnicastIpAddressTable', 'hotspot addressing uses native IP Helper'],
  ['InterfaceGuid', 'hotspot adapter identity remains GUID based'],
  ['target-identification-ambiguous', 'ambiguous discovery remains fail-closed'],
  ['is_mobile_hotspot_adapter', 'modern Mobile Hotspot remains eligible'],
  [
    'is_windows_mobile_hotspot_identity',
    'Windows-owned Mobile Hotspot remains tracked',
  ],
  [
    'NetworkInformation::GetInternetConnectionProfile',
    'physical Internet adapter is discovered dynamically',
  ],
  ['NetworkAdapterId', 'physical upstream is persisted by adapter GUID'],
  ['EnableSharing(ICSSHARINGTYPE_PRIVATE)', 'active hotspot is made ICS PRIVATE'],
  ['EnableSharing(ICSSHARINGTYPE_PUBLIC)', 'Mihomo TUN is made ICS PUBLIC'],
  ['save_snapshot', 'original ICS state is persisted before mutation'],
  [
    'snapshot.version != 2 && snapshot.version != 3',
    'historical lease snapshots remain upgrade-readable',
  ],
  [
    'restore dynamically captured Mobile Hotspot upstream as PUBLIC',
    'hidden Windows hotspot state retains a dynamic restore fallback',
  ],
  [
    'preserve Windows Mobile Hotspot PRIVATE side during restore',
    'restore does not tear down the Windows-owned hotspot side',
  ],
  ['restore_snapshot_unlocked', 'ICS state retains a rollback path'],
  ['rollback-immediately', 'failed apply rolls back immediately'],
  ['lease_roles_are_desired', 'post-apply role readback remains verified'],
  ['restore_now', 'shutdown and TUN-off explicit restore remains available'],
  [
    'const LOOP_INTERVAL: Duration = Duration::from_secs(2);',
    'hotspot topology remains monitored',
  ],
  [
    'const STABLE_SAMPLES: u8 = 3;',
    'hotspot topology changes require stable observations',
  ],
  ['hardcoded_upstream_interface', 'diagnostics certify dynamic upstream behavior'],
  ['hardcoded_hotspot_subnet', 'diagnostics certify dynamic hotspot behavior'],
  [
    'windows-hotspot-ics-lease-v20.json',
    'v27 reuses the existing persistent lease snapshot path',
  ],
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
  forbidText(forbidden, 'v27 remains generic and release-safe')
}

requireText(
  'manifest',
  '"Networking_Connectivity"',
  'dynamic upstream GUID discovery feature remains enabled',
)
requireText(
  'utils',
  'pub mod windows_network;',
  'Windows managed routing module remains compiled',
)

if (failures.length) {
  console.error('[windows-tun-safety-v27] FAILED')
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}

console.log('[windows-tun-safety-v27] OK')
console.log('[通过] v26 native route/forwarding-safe 不变量保留')
console.log('[通过] Mobile Hotspot=ICS PRIVATE，Mihomo TUN=ICS PUBLIC')
console.log('[通过] 动态 GUID 识别、持久快照、readback、回滚和恢复均受门禁保护')
console.log('[通过] 无 SSID / 固定 ifIndex / 固定热点子网 / PowerShell 路径')
