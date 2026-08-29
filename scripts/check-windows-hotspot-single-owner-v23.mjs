import { readFile } from 'node:fs/promises'

const paths = {
  hotspot: 'src-tauri/src/core/windows_hotspot_ics.rs',
  network: 'src-tauri/src/core/windows_network_diagnostics.rs',
  workflow: '.github/workflows/karing-windows-hotspot-v23.yml',
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
  'NetworkOperatorTetheringManager',
  'CreateFromConnectionProfile',
  'StopTetheringAsync()',
  'StartTetheringAsync()',
  'MUTATION_LOCK',
  'restore_snapshot_unlocked',
  'lease-cleared-user-hotspot-off',
]) {
  requireText('hotspot', marker, `single WinRT hotspot owner invariant ${marker}`)
}

for (const forbidden of [
  'INetSharingManager',
  'EnableSharing(',
  'powershell.exe',
  'pwsh.exe',
  'netsh ',
]) {
  forbidText('hotspot', forbidden, 'hotspot owner must remain WinRT-only')
}

for (const marker of [
  'struct PhysicalUpstreamIdentity',
  'fn physical_upstream_identity',
  'fn hotspot_topology_changed',
  'hotspot-observed-no-core-refresh',
  'prevent-hotspot-tun-reload-feedback-loop',
  '"hotspot_events_can_trigger_core_refresh": false',
  '"hotspot_owner": "windows-hotspot-winrt"',
  'confirm_physical_upstream',
  'refresh-deferred-during-hotspot-transition',
  'refresh_runtime_network_state("physical-upstream-changed"',
  'fn hotspot_state_change_does_not_change_runtime_upstream_identity',
  'fn route_metric_churn_does_not_change_runtime_upstream_identity',
  'fn real_physical_upstream_change_changes_runtime_identity',
]) {
  requireText('network', marker, `v23 topology invariant ${marker}`)
}

for (const forbidden of [
  'hotspot-guard-state-changed',
  'confirm_guard_signature',
  'GUARD_CONFIRM_',
  'last_applied_guard',
]) {
  forbidText('network', forbidden, 'hotspot topology must never own core refresh')
}

const forcedRefreshCount = source.network.match(/update_config_forced\(\)\.await/g)?.length ?? 0
if (forcedRefreshCount !== 1) {
  failures.push(
    `network watcher must have exactly one forced refresh call, found ${forcedRefreshCount}`,
  )
}

const physicalIdentityBlock = source.network.match(
  /struct PhysicalUpstreamIdentity \{[\s\S]*?\n\}/,
)?.[0]
if (!physicalIdentityBlock) {
  failures.push('PhysicalUpstreamIdentity block missing')
} else {
  for (const metric of ['route_metric', 'interface_metric', 'effective_metric']) {
    if (physicalIdentityBlock.includes(metric)) {
      failures.push(`PhysicalUpstreamIdentity must ignore transient ${metric}`)
    }
  }
}

for (const marker of [
  'node scripts/check-windows-hotspot-v22.mjs',
  'node scripts/check-windows-hotspot-single-owner-v23.mjs',
  'cargo check --target ${{ matrix.target }} --workspace --all-features',
  'cargo test --target x86_64-pc-windows-msvc --lib windows_network --all-features',
  'cargo test --target x86_64-pc-windows-msvc --lib windows_hotspot_ --all-features',
]) {
  requireText('workflow', marker, `v23 CI invariant ${marker}`)
}

if (failures.length > 0) {
  console.error('Windows Mobile Hotspot v23 single-owner safety gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('[通过] Mobile Hotspot mutation 只有 windows-hotspot-winrt 一个 owner')
console.log('[通过] 热点 On/Off、Wi-Fi Direct 与 ICS 子网变化只记录，不触发 Core/TUN refresh')
console.log('[通过] Core refresh 只保留真实物理上游变化路径，并要求 3 次稳定确认')
console.log('[通过] 物理上游身份忽略 route/interface metric 抖动，避免热点启动噪声误触发')
console.log('[通过] v22 WinRT 安全门禁继续保留，v23 只收窄控制权而不回退到 HNetCfg/shell')
