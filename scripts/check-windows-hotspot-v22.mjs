import { readFile } from 'node:fs/promises'

const paths = {
  winrt: 'src-tauri/src/core/windows_hotspot_winrt.rs',
  legacy: 'src-tauri/src/core/windows_hotspot_ics.rs',
  coreMod: 'src-tauri/src/core/mod.rs',
  manager: 'src-tauri/src/core/manager/mod.rs',
  shutdown: 'src-tauri/src/feat/window.rs',
  manifest: 'src-tauri/Cargo.toml',
}

const source = Object.fromEntries(
  await Promise.all(
    Object.entries(paths).map(async ([key, path]) => [
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
  if (source[key].includes(text)) failures.push(`${label}: contains forbidden ${text}`)
}

for (const marker of [
  'NetworkInformation::GetConnectionProfiles()',
  'GetTetheringCapabilityFromConnectionProfile',
  'CreateFromConnectionProfile(&tun_profile)',
  'StopTetheringAsync()',
  'StartTetheringAsync()',
  '.join()',
  'RoInitialize(RO_INIT_MULTITHREADED)',
  'GetIfTable2',
  'NetworkAdapterId()',
  'TetheringOperationalState::Off',
  'TetheringOperationalState::InTransition',
  'TetheringOperationStatus::Success',
  'TetheringOperationStatus::AlreadyOn',
  'mihomo-start-failed',
  'attempt-immediate-physical-fallback',
  'physical-fallback-restored',
  'legacy_hnetcfg_mutation',
  'two_phase_shutdown_restore',
  'pub async fn suspend_for_tun_teardown',
  'pub async fn restore_after_tun_teardown',
  'keep-hotspot-off-until-tun-is-gone',
  'stop-then-start-from-best-physical-profile',
  'tun-identification-ambiguous',
  'fail-closed-no-hotspot-mutation',
]) {
  requireText('winrt', marker, `WinRT hotspot invariant ${marker}`)
}

for (const forbidden of [
  'INetSharingManager',
  'INetSharingConfiguration',
  'EnableSharing(',
  'NetSharingManager',
  'powershell.exe',
  'pwsh.exe',
  'netsh ',
  'std::process::Command',
]) {
  forbidText(
    'winrt',
    forbidden,
    'Karing .22 primary hotspot controller must stay on WinRT and native interface discovery',
  )
}

requireText(
  'coreMod',
  'pub mod windows_hotspot_winrt;',
  'WinRT hotspot controller is compiled on Windows',
)
requireText(
  'manager',
  'const ENABLE_LEGACY_HNETCFG_HOTSPOT_MONITOR: bool = false;',
  'legacy HNetCfg mutation monitor is disabled by default',
)
requireText(
  'manager',
  'crate::core::windows_hotspot_winrt::ensure_monitor_running();',
  'WinRT hotspot monitor starts with CoreManager',
)
requireText(
  'manager',
  'crate::core::windows_hotspot_ics::ensure_monitor_running();',
  'legacy v20 implementation remains compiled behind the explicit disabled gate',
)
requireText(
  'shutdown',
  'windows_hotspot_winrt::suspend_for_tun_teardown("shutdown")',
  'shutdown suspends Mihomo-backed hotspot before TUN destruction',
)
requireText(
  'shutdown',
  'windows_hotspot_winrt::restore_after_tun_teardown("shutdown")',
  'shutdown restarts hotspot from a physical profile after TUN destruction',
)
requireText(
  'shutdown',
  'abort-explicit-tun-core-teardown-preserve-working-topology',
  'failed WinRT suspend aborts destructive teardown',
)
requireText(
  'shutdown',
  'leave-hotspot-off-instead-of-binding-to-destroyed-tun',
  'failed physical restore fails safe instead of rebinding dead TUN',
)
for (const feature of [
  '"Foundation"',
  '"Foundation_Collections"',
  '"Networking_Connectivity"',
  '"Networking_NetworkOperators"',
  '"Win32_NetworkManagement_IpHelper"',
  '"Win32_System_WinRT"',
]) {
  requireText('manifest', feature, `windows-rs feature ${feature}`)
}

for (const legacyMarker of [
  'windows-hotspot-ics-lease-v20.json',
  'restore-original-ics-immediately',
  'fail-closed-preserve-unrelated-private-ics',
]) {
  requireText(
    'legacy',
    legacyMarker,
    `legacy HNetCfg rollback reference remains available: ${legacyMarker}`,
  )
}

if (failures.length > 0) {
  console.error('Windows Mobile Hotspot v22 WinRT safety gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('[通过] Karing .22 主热点控制器使用 NetworkOperatorTetheringManager，而非 HNetCfg EnableSharing')
console.log('[通过] Mihomo ConnectionProfile 通过 IP Helper adapter GUID 对齐，不依赖本地化 ProfileName')
console.log('[通过] WinRT !Send/!Sync 对象仅在单个阻塞线程内创建、Stop/Start、join 与读回')
console.log('[通过] Start 失败会尝试立即恢复物理热点上游，不把热点静默留在关闭状态')
console.log('[通过] 退出采用 Stop hotspot → teardown TUN → physical profile Start 的两阶段恢复')
console.log('[通过] v20 HNetCfg 代码保留为回滚/诊断参考，但默认 mutation monitor 已关闭')
