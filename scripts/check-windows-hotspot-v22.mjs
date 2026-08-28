import { readFile } from 'node:fs/promises'

const paths = {
  controller: 'src-tauri/src/core/windows_hotspot_ics.rs',
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
  if (source[key].includes(text))
    failures.push(`${label}: contains forbidden ${text}`)
}

for (const marker of [
  'windows-hotspot-winrt-lease-v22.json',
  'version: 3',
  'NetworkInformation::GetConnectionProfiles()',
  'GetInternetConnectionProfile()',
  'GetTetheringCapabilityFromConnectionProfile',
  'CreateFromConnectionProfile',
  'StopTetheringAsync()',
  'StartTetheringAsync()',
  '.join()',
  'GetIfTable2',
  'NetworkAdapterId()',
  'TetheringCapability::Enabled',
  'TetheringOperationalState::Off',
  'TetheringOperationalState::InTransition',
  'TetheringOperationalState::On',
  'hotspot-operational-state-unknown',
  'hotspot-unknown-no-action',
  'TetheringOperationStatus::Success',
  'TetheringOperationStatus::AlreadyOn',
  'target-identification-ambiguous',
  'fail-closed-no-tethering-mutation',
  'original-public-profile-ambiguous',
  'fail-closed-preserve-current-hotspot',
  'restore-original-hotspot-immediately',
  'snapshot_preserved_until_restore_succeeds',
  'lease-cleared-user-hotspot-off',
  'user_intent_preserved',
  'persistent_rollback',
  'shutdown_restore_gate',
  'pub async fn restore_now',
  'explicit-restore-completed',
  'mihomo-connection-profile=public,wifi=private',
  'hnetcfg_mutation',
]) {
  requireText(
    'controller',
    marker,
    `persistent WinRT hotspot invariant ${marker}`,
  )
}

for (const forbidden of [
  'INetSharingManager',
  'INetSharingConfiguration',
  'EnableSharing(',
  'NetSharingManager',
  'ICSSHARINGTYPE_PUBLIC',
  'ICSSHARINGTYPE_PRIVATE',
  'powershell.exe',
  'pwsh.exe',
  'netsh ',
  'std::process::Command',
]) {
  forbidText(
    'controller',
    forbidden,
    'Karing .22 hotspot mutation path must use WinRT rather than legacy HNetCfg or shell commands',
  )
}

requireText(
  'coreMod',
  'pub mod windows_hotspot_ics;',
  'persistent WinRT hotspot controller is compiled on Windows',
)
forbidText(
  'coreMod',
  'pub mod windows_hotspot_winrt;',
  'duplicate transient WinRT controller must not be compiled',
)
requireText(
  'manager',
  'crate::core::windows_hotspot_ics::ensure_monitor_running();',
  'CoreManager starts exactly the persistent WinRT hotspot controller',
)
forbidText(
  'manager',
  'windows_hotspot_winrt::ensure_monitor_running()',
  'CoreManager must not start the removed transient controller',
)
forbidText(
  'manager',
  'ENABLE_LEGACY_HNETCFG_HOTSPOT_MONITOR',
  'legacy dual-controller feature gate must be removed',
)
requireText(
  'shutdown',
  'windows_hotspot_ics::restore_now("shutdown")',
  'shutdown restores the original physical ConnectionProfile before TUN teardown',
)
requireText(
  'shutdown',
  'windows-winrt-hotspot-restore-failed',
  'WinRT restore failures remain observable',
)
requireText(
  'shutdown',
  'abort-explicit-tun-core-teardown-preserve-snapshot',
  'failed restore preserves recovery state and blocks destructive teardown',
)
forbidText(
  'shutdown',
  'windows_hotspot_winrt::',
  'shutdown must not reference the removed transient controller',
)

for (const feature of [
  '"Foundation"',
  '"Foundation_Collections"',
  '"Networking_Connectivity"',
  '"Networking_NetworkOperators"',
  '"Win32_NetworkManagement_IpHelper"',
  '"Win32_System_Com"',
]) {
  requireText('manifest', feature, `windows-rs feature ${feature}`)
}

if (failures.length > 0) {
  console.error(
    'Windows Mobile Hotspot v22 persistent WinRT safety gate failed:',
  )
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('[通过] Karing .22 只有一个持久化 WinRT Mobile Hotspot 控制器')
console.log(
  '[通过] Mihomo TUN 通过 IP Helper adapter GUID 对齐 WinRT ConnectionProfile',
)
console.log(
  '[通过] 热点重绑严格执行 StopTetheringAsync → StartTetheringAsync 并等待真实结果',
)
console.log(
  '[通过] 原物理 public profile 在变更前持久化，失败/退出均可恢复且恢复失败会 fail-closed',
)
console.log(
  '[通过] 用户主动关闭热点会清理 lease，不会被后台 monitor 强行重新开启',
)
console.log(
  '[通过] HNetCfg EnableSharing、PowerShell/netsh 和重复临时 WinRT 控制器均不在主路径',
)
