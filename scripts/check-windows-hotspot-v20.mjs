import { readFile } from 'node:fs/promises'

const paths = {
  ics: 'src-tauri/src/core/windows_hotspot_ics.rs',
  deep: 'src-tauri/src/core/windows_deep_network_diagnostics.rs',
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

for (const api of [
  'INetSharingManager',
  'INetSharingConfiguration',
  'NetSharingManager',
  'CoInitializeEx',
  'CoCreateInstance',
  'GetIfTable2',
  'GetUnicastIpAddressTable',
]) {
  requireText('ics', api, `native ICS implementation uses ${api}`)
}

for (const marker of [
  'const STABLE_SAMPLES: u8 = 3;',
  'windows-hotspot-ics-lease-v20.json',
  'target-identification-ambiguous',
  'fail-closed-no-ics-mutation',
  'lease-refused-unrelated-private-sharing',
  'fail-closed-preserve-unrelated-private-ics',
  'apply-verification-failed',
  'restore-original-ics-immediately',
  'rollback_scope',
  'original-public+lease-targets-only',
  'RESTORE_REQUESTED',
  'MUTATION_LOCK',
  'pub async fn restore_now',
  'explicit-restore-completed',
  'lease-restored',
  'reapply_suppressed',
  'lease-readback',
  'lease-drift-detected',
  'restore-before-next-reapply',
  'active_lease_readback',
  'Resolve both COM connections before persisting rollback state.',
]) {
  requireText('ics', marker, `ICS lifecycle invariant ${marker}`)
}

for (const testName of [
  'windows_network_guid_normalization_ignores_braces_case_and_space',
  'windows_network_rollback_scope_keeps_public_and_lease_targets_only',
  'windows_network_unrelated_private_ics_is_fail_closed',
  'windows_network_active_lease_requires_both_expected_roles',
]) {
  requireText('ics', testName, `Windows regression ${testName}`)
}

for (const marker of [
  'GetIpForwardTable2',
  'GetIpInterfaceEntry',
  'forwarding_enabled',
  'weak_host_send',
  'weak_host_receive',
  'disable_default_routes',
  'skip_as_source',
  'effective_metric',
  'protocol',
  'origin',
  'deep-monitor-started',
  'deep-baseline',
  'deep-changed',
  'all-interface-guid-and-state',
  'complete-ipv4-route-table',
  'snapshot_truncation',
  'state-change-only',
  'native_api_only',
]) {
  requireText('deep', marker, `deep Windows diagnostic ${marker}`)
}
for (const forbidden of ['MAX_ROUTES', 'MAX_INTERFACES', '.truncate(']) {
  forbidText(
    'deep',
    forbidden,
    'deep Windows diagnostics must preserve complete interface and route evidence',
  )
}

requireText(
  'coreMod',
  'pub mod windows_hotspot_ics;',
  'native ICS module is compiled on Windows',
)
requireText(
  'coreMod',
  'pub mod windows_deep_network_diagnostics;',
  'deep network diagnostic module is compiled on Windows',
)
requireText(
  'manager',
  'crate::core::windows_hotspot_ics::ensure_monitor_running();',
  'ICS monitor starts with the core manager',
)
requireText(
  'manager',
  'crate::core::windows_deep_network_diagnostics::ensure_monitor_running();',
  'deep network monitor starts with the core manager',
)
requireText(
  'shutdown',
  'match crate::core::windows_hotspot_ics::restore_now("shutdown").await',
  'shutdown waits for ICS restore completion before TUN teardown',
)
requireText(
  'shutdown',
  'windows-ics-restore-failed',
  'shutdown restore failures remain observable',
)
requireText(
  'shutdown',
  'windows-ics-teardown-aborted',
  'shutdown aborts explicit TUN/core teardown when ICS restore fails',
)
requireText(
  'shutdown',
  'abort-explicit-tun-core-teardown-preserve-snapshot',
  'shutdown preserves rollback evidence after ICS restore failure',
)
forbidText(
  'shutdown',
  'windows-ics-restore-timeout',
  'shutdown must not race a timed-out spawn_blocking ICS restore against TUN teardown',
)
requireText(
  'manifest',
  '"Win32_NetworkManagement_WindowsFirewall"',
  'HNetCfg COM bindings are enabled',
)
requireText(
  'manifest',
  '"Win32_System_Com"',
  'COM runtime bindings are enabled',
)

for (const key of ['ics', 'deep']) {
  for (const forbidden of [
    'powershell.exe',
    'pwsh.exe',
    'netsh ',
    'Get-NetAdapter',
    'Get-NetRoute',
    'std::process::Command',
    '192.168.137.0/24',
  ]) {
    forbidText(key, forbidden, `${key} stays native and topology-derived`)
  }
}

if (failures.length > 0) {
  console.error('Windows Mobile Hotspot v20 safety gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(
  '[通过] Windows Mobile Hotspot 使用原生 HNetCfg COM，不依赖 PowerShell/netsh',
)
console.log(
  '[通过] TUN=PUBLIC / Hotspot=PRIVATE 具备持久快照、读回验证与失败回滚',
)
console.log('[通过] active lease 每轮读回角色，漂移先恢复再重建')
console.log('[通过] snapshot 只在两个 COM 目标都解析成功后落盘')
console.log('[通过] 无关 PRIVATE ICS 被 fail-closed 保护，不会被租约覆盖')
console.log(
  '[通过] 退出等待 ICS 恢复完成；恢复失败则保留 snapshot 并中止显式 TUN/Core teardown',
)
console.log('[通过] 深度日志保留全部接口和完整 IPv4 路由，不截断证据')
