import { readFile } from 'node:fs/promises'

const paths = {
  hotspot: 'src-tauri/src/core/windows_hotspot_ics.rs',
  network: 'src-tauri/src/core/windows_network_diagnostics.rs',
  runtime: 'src-tauri/src/utils/windows_network.rs',
  shutdown: 'src-tauri/src/feat/window.rs',
  v22Compat: 'scripts/check-windows-hotspot-v22.mjs',
  v23Compat: 'scripts/check-windows-hotspot-single-owner-v23.mjs',
  hotspotWorkflow: '.github/workflows/karing-windows-hotspot-v24.yml',
}

const source = Object.fromEntries(
  await Promise.all(
    Object.entries(paths).map(async ([key, path]) => [key, await readFile(path, 'utf8')]),
  ),
)

const failures = []
const requireText = (key, text, label) => {
  if (!source[key].includes(text)) failures.push(`${label}: missing ${text}`)
}
const forbidText = (key, text, label) => {
  if (source[key].includes(text)) failures.push(`${label}: contains forbidden ${text}`)
}

// v24 control-plane contract: Karing may bind ICS roles for the VPN data plane,
// but it must never own the Mobile Hotspot radio/session lifecycle.
for (const forbidden of [
  'NetworkOperatorTetheringManager',
  'CreateFromConnectionProfile',
  'StartTetheringAsync',
  'StopTetheringAsync',
  'TetheringOperationalState',
  'powershell.exe',
  'pwsh.exe',
  'netsh ',
  'Set-NetIPInterface',
  'IPEnableRouter',
]) {
  forbidText('hotspot', forbidden, `Mobile Hotspot lifecycle must stay Windows/user-owned ${forbidden}`)
}

// v24 data-plane contract: use the already proven native ICS topology lease,
// not hotspot restart/rebind, so hotspot clients still traverse Mihomo TUN.
for (const marker of [
  'INetSharingManager',
  'INetSharingConfiguration',
  'NetSharingManager',
  'ICSSHARINGTYPE_PUBLIC',
  'ICSSHARINGTYPE_PRIVATE',
  'TargetPair',
  'Mihomo TUN connection disappeared before ICS apply',
  'Mobile Hotspot connection disappeared before ICS apply',
  'mihomo-tun-as-ics-public-with-persistent-rollback',
  'desired_topology',
  'mihomo-tun=public,windows-mobile-hotspot=private',
  'fail-closed-no-ics-mutation',
  'rollback_scope',
  'original-public+lease-targets-only',
  'active_lease_readback',
]) {
  requireText('hotspot', marker, `native ICS VPN data-plane invariant ${marker}`)
}

for (const forbidden of [
  '192.168.137.',
  '本地连接*',
  'Local Area Connection*',
  'Restart-Service',
  'SharedAccess start=',
]) {
  forbidText('hotspot', forbidden, `ICS implementation must remain identity-driven and shell-free ${forbidden}`)
}

for (const marker of [
  'fn hotspot_topology_changed',
  'hotspot-observed-no-core-refresh',
  'prevent-hotspot-tun-reload-feedback-loop',
  '"hotspot_events_can_trigger_core_refresh": false',
  'confirm_physical_upstream',
  'refresh-deferred-during-hotspot-transition',
  'refresh_runtime_network_state("physical-upstream-changed"',
]) {
  requireText('network', marker, `hotspot observability-only Core invariant ${marker}`)
}

for (const marker of [
  'managed_physical_route_guards',
  'managed_upstream_uses_physical_only_runtime_guards',
  'managed_upstream_preserves_user_strict_route',
  'route_signature_ignores_metric_churn_and_runtime_guards',
]) {
  requireText('runtime', marker, `stable physical upstream invariant ${marker}`)
}

for (const forbidden of [
  'apply_hotspot_strict_route_compat',
  'hotspot_ready',
  'merge_string_sequence(tun, "exclude-interface"',
]) {
  forbidText('runtime', forbidden, 'Mihomo Runtime must not be regenerated from hotspot state')
}

requireText(
  'shutdown',
  'windows_hotspot_ics::restore_now("shutdown")',
  'shutdown must restore only the ICS data-plane lease before TUN teardown',
)
for (const marker of [
  'RESTORE_REQUESTED.store(true',
  'restore_snapshot_unlocked',
  'explicit-restore-completed',
]) {
  requireText('hotspot', marker, `ICS rollback invariant ${marker}`)
}

for (const key of ['v22Compat', 'v23Compat']) {
  requireText(
    key,
    "await import('./check-windows-hotspot-zero-owner-v24.mjs')",
    `${key} must delegate to the v24 lifecycle/data-plane gate`,
  )
}
requireText(
  'hotspotWorkflow',
  'check-windows-hotspot-zero-owner-v24.mjs',
  'v24 workflow must execute the lifecycle/data-plane gate',
)
for (const marker of [
  'cargo check --target ${{ matrix.target }} --workspace --all-features',
  'cargo test --target x86_64-pc-windows-msvc --lib windows_network --all-features',
  'cargo test --target x86_64-pc-windows-msvc --lib windows_hotspot_ --all-features',
]) {
  requireText('hotspotWorkflow', marker, `v24 Windows regression ${marker}`)
}

if (failures.length > 0) {
  console.error('Windows Mobile Hotspot v24 lifecycle/data-plane safety gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('[通过] Mobile Hotspot Start/Stop 生命周期保持 Windows/用户所有，Karing 写入路径 = 0')
console.log('[通过] Karing 只管理原生 HNetCfg ICS 数据面：Mihomo TUN=PUBLIC，热点侧=PRIVATE')
console.log('[通过] ICS 目标按 GUID/设备身份动态识别，不依赖 shell、本地化网卡名或固定热点网段')
console.log('[通过] ICS 变更具备持久 rollback、读回验证、歧义/无关 PRIVATE 共享 fail-closed')
console.log('[通过] 热点拓扑变化不触发 Core/TUN refresh；Runtime 仍只追踪稳定物理上游')
console.log('[通过] Windows x64/ARM64 编译及 hotspot/network 回归被 v24 专项 workflow 强制执行')
