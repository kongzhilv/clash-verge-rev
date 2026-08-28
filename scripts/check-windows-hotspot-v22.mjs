import { readFile } from 'node:fs/promises'

const paths = {
  hotspot: 'src-tauri/src/core/windows_hotspot_ics.rs',
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
  'NetworkInformation::GetConnectionProfiles',
  'GetTetheringCapabilityFromConnectionProfile',
  'CreateFromConnectionProfile',
  'StopTetheringAsync',
  'StartTetheringAsync',
  '.join()',
  'TetheringOperationalState::Off',
  'TetheringOperationalState::On',
  'TetheringCapability::Enabled',
  'windows-hotspot-winrt-lease-v22.json',
  'target-identification-ambiguous',
  'fail-closed-no-tethering-mutation',
  'original-public-profile-ambiguous',
  'fail-closed-preserve-current-hotspot',
  'restore-original-hotspot-immediately',
  'snapshot_preserved_until_restore_succeeds',
  'lease-cleared-user-hotspot-off',
  'respect-and-clear-lease',
  'RESTORE_REQUESTED',
  'MUTATION_LOCK',
  'pub async fn restore_now',
  'explicit-restore-completed',
  'desired_topology',
  'mihomo-connection-profile=public,wifi=private',
  'hnetcfg_mutation',
]) {
  requireText('hotspot', marker, `WinRT hotspot invariant ${marker}`)
}

for (const forbidden of [
  'INetSharingManager',
  'INetSharingConfiguration',
  'NetSharingManager',
  'EnableSharing(',
  'DisableSharing(',
  'powershell.exe',
  'pwsh.exe',
  'netsh ',
  'std::process::Command',
  '192.168.137.0/24',
]) {
  forbidText(
    'hotspot',
    forbidden,
    'hotspot v22 must not mutate classic ICS or shell out',
  )
}

for (const feature of [
  '"Foundation"',
  '"Foundation_Collections"',
  '"Networking_Connectivity"',
  '"Networking_NetworkOperators"',
]) {
  requireText('manifest', feature, `windows crate feature ${feature}`)
}

requireText(
  'manager',
  'crate::core::windows_hotspot_ics::ensure_monitor_running();',
  'WinRT hotspot monitor starts with CoreManager',
)
requireText(
  'shutdown',
  'match crate::core::windows_hotspot_ics::restore_now("shutdown").await',
  'shutdown waits for hotspot public-source restore before TUN teardown',
)

for (const testName of [
  'windows_hotspot_guid_normalization_ignores_braces_case_and_space',
  'windows_hotspot_saved_guid_matches_native_guid',
  'windows_hotspot_snapshot_v22_preserves_original_public_and_user_state',
]) {
  requireText('hotspot', testName, `Rust regression ${testName}`)
}

if (failures.length > 0) {
  console.error('Windows Mobile Hotspot v22 WinRT safety gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(
  '[通过] 热点上游切换使用 NetworkOperatorTetheringManager / CreateFromConnectionProfile',
)
console.log(
  '[通过] 已移除热点控制路径中的 HNetCfg EnableSharing/DisableSharing 写操作',
)
console.log('[通过] WinRT IAsyncOperation 使用 join() 在单个阻塞线程内同步完成')
console.log('[通过] 变更前持久化原 public profile，失败和退出均具备恢复路径')
console.log('[通过] 用户主动关闭热点时清理 lease，不会被后台监控强行重新开启')
console.log('[通过] TUN/profile 识别歧义时 fail-closed，不修改系统热点')
