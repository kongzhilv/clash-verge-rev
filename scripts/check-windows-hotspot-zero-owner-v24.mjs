import { readFile } from 'node:fs/promises'

const paths = {
  hotspot: 'src-tauri/src/core/windows_hotspot_ics.rs',
  network: 'src-tauri/src/core/windows_network_diagnostics.rs',
  runtime: 'src-tauri/src/utils/windows_network.rs',
  shutdown: 'src-tauri/src/feat/window.rs',
  mainWorkflow: '.github/workflows/karing-diagnostics-once.yml',
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

for (const marker of [
  'zero-hotspot-lifecycle-owner',
  'leave-hotspot-unchanged',
  'hotspot_lifecycle_mutation": false',
  'physical_forwarding_mutation": false',
  'global_ip_forwarding_mutation": false',
  'polling_reconcile": false',
  'persistent_hotspot_lease": false',
]) {
  requireText('hotspot', marker, `zero-owner runtime contract ${marker}`)
}

for (const forbidden of [
  'NetworkOperatorTetheringManager',
  'CreateFromConnectionProfile',
  'StartTetheringAsync',
  'StopTetheringAsync',
  'INetSharingManager',
  'EnableSharing(',
  'MUTATION_LOCK',
  'SNAPSHOT_FILE',
  'SavedTetheringState',
  'windows-hotspot-winrt-lease',
  'rebind-stop-existing',
  'rebind-start-mihomo',
  'restore_snapshot_unlocked',
  'LOOP_INTERVAL',
  'reconcile_once',
  'Set-NetIPInterface',
  'IPEnableRouter',
]) {
  forbidText('hotspot', forbidden, `Karing must never own Mobile Hotspot lifecycle ${forbidden}`)
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
  requireText('network', marker, `hotspot observability-only invariant ${marker}`)
}

for (const marker of [
  'managed_physical_route_guards',
  'managed_upstream_uses_physical_only_runtime_guards',
  'managed_upstream_preserves_user_strict_route',
  'route_signature_ignores_metric_churn_and_runtime_guards',
]) {
  requireText('runtime', marker, `TUN physical-upstream invariant ${marker}`)
}

for (const forbidden of [
  'apply_hotspot_strict_route_compat',
  'hotspot_ready',
  'merge_string_sequence(tun, "exclude-interface"',
]) {
  forbidText('runtime', forbidden, 'Mihomo runtime must not be regenerated from hotspot state')
}

requireText(
  'shutdown',
  'windows_hotspot_ics::restore_now("shutdown")',
  'shutdown compatibility hook remains explicit',
)
requireText(
  'hotspot',
  'restore-skipped-no-ownership',
  'shutdown compatibility hook is a no-op',
)

for (const key of ['mainWorkflow', 'hotspotWorkflow']) {
  requireText(
    key,
    'check-windows-hotspot-zero-owner-v24.mjs',
    `${key} must execute the v24 zero-owner gate`,
  )
}
for (const marker of [
  'cargo check --target ${{ matrix.target }} --workspace --all-features',
  'cargo test --target x86_64-pc-windows-msvc --lib windows_network --all-features',
  'cargo test --target x86_64-pc-windows-msvc --lib windows_hotspot_ --all-features',
]) {
  requireText('hotspotWorkflow', marker, `v24 Windows regression ${marker}`)
}

if (failures.length > 0) {
  console.error('Windows Mobile Hotspot v24 zero-owner safety gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('[通过] Karing 对 Windows Mobile Hotspot 生命周期拥有 0 个写入路径')
console.log('[通过] 应用启动、TUN 开关、Core reload 与退出均不得 Start/Stop/重绑热点')
console.log('[通过] 热点/Wi-Fi Direct/ICS 子网变化仅观测，不拥有 Core refresh')
console.log('[通过] TUN Runtime 继续只绑定稳定物理上游，不开启物理/全局 IP forwarding')
console.log('[通过] Windows x64/ARM64 编译与热点/网络回归被 v24 专项工作流强制执行')
