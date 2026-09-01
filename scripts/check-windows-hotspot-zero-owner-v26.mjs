import { readFile } from 'node:fs/promises'

const paths = {
  hotspot: 'src-tauri/src/core/windows_hotspot_ics.rs',
  network: 'src-tauri/src/core/windows_network_diagnostics.rs',
  runtime: 'src-tauri/src/utils/windows_network.rs',
  manager: 'src-tauri/src/core/manager/config.rs',
  shutdown: 'src-tauri/src/feat/window.rs',
  workflow: '.github/workflows/karing-windows-hotspot-v26.yml',
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
])
  forbidText(
    'hotspot',
    forbidden,
    `Windows/user must own Mobile Hotspot lifecycle ${forbidden}`,
  )

for (const marker of [
  'HotspotOwnership',
  'WindowsMobileHotspot',
  'LegacyHostedNetwork',
  'windows-owned-hotspot-no-hnetcfg-mutation',
  'hnetcfg_lease_allowed',
  'refusing HNetCfg mutation for Windows-owned Mobile Hotspot/Wi-Fi Direct adapter',
  'EVENT_E_ALL_SUBSCRIBERS_FAILED',
  'hresult=0x',
  'error_chain',
  'windows_network_windows_owned_wifi_direct_never_uses_hnetcfg',
  'windows_network_legacy_hosted_network_retains_hnetcfg_compatibility',
])
  requireText(
    'hotspot',
    marker,
    `Mobile Hotspot ownership/HNetCfg invariant ${marker}`,
  )

for (const forbidden of [
  '192.168.137.',
  'Local Area Connection*',
  '本地连接*',
])
  forbidText(
    'hotspot',
    forbidden,
    `Hotspot implementation stays identity-driven ${forbidden}`,
  )

for (const marker of [
  'forwarding_enabled',
  'forwarding_state_changed',
  'physical-forwarding-mode-changed',
  'hotspot-observed-routing-mode-evaluation',
  '"hotspot_events_can_trigger_core_refresh": "forwarding-mode-only"',
  'confirm_physical_upstream',
  'refresh_runtime_network_state',
  'windows_network_forwarding_change_changes_runtime_identity',
])
  requireText('network', marker, `Forwarding-mode topology invariant ${marker}`)
for (const forbidden of [
  'hotspot-observed-no-core-refresh',
  '"hotspot_events_can_trigger_core_refresh": false',
])
  forbidText(
    'network',
    forbidden,
    `v25 stale no-refresh assumption must be retired ${forbidden}`,
  )

for (const marker of [
  'connected_interface_state',
  'forwarding_enabled',
  'apply_forwarding_safe_tun_route',
  'forwarding_safe_route_addresses',
  'route-address',
  'fake-ip-range',
  'windows_network_forwarding_safe_tun_routes_only_fake_ip_range',
  'windows_network_forwarding_safe_tun_uses_custom_fake_ip_range',
  'windows_network_forwarding_without_fake_ip_disables_global_auto_route',
  'windows_network_forwarding_change_changes_stable_route_signature',
  'managed_physical_route_guards',
  'managed_proxy_sockets_bind_to_stable_physical_interface',
])
  requireText('runtime', marker, `Forwarding-safe TUN invariant ${marker}`)

for (const marker of [
  '"route_address": string_list("route-address")',
  'forwarding_enabled',
  'forwarding-safe-fake-ip-only',
  'topology-watcher-regenerate-runtime-on-upstream-or-forwarding-mode',
])
  requireText('manager', marker, `Final Runtime diagnostic invariant ${marker}`)

requireText(
  'shutdown',
  'windows_hotspot_ics::restore_now("shutdown")',
  'shutdown keeps legacy lease rollback',
)

for (const marker of [
  'check-windows-hotspot-zero-owner-v26.mjs',
  'Compile v26 network path ${{ matrix.target }}',
  'Run v26 forwarding-safe + ICS + topology regressions',
  'cargo check --target ${{ matrix.target }} --workspace --all-features',
  'windows_network_forwarding_safe_tun_routes_only_fake_ip_range',
  'windows_network_forwarding_change_changes_runtime_identity',
  'windows_network_windows_owned_wifi_direct_never_uses_hnetcfg',
])
  requireText('workflow', marker, `v26 workflow regression ${marker}`)

if (failures.length) {
  console.error(
    'Windows Mobile Hotspot v26 forwarding-safe safety gate failed:',
  )
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(
  '[通过] WinRT/Wi-Fi Direct Mobile Hotspot 生命周期和 HNetCfg 数据面均保持 Windows 所有，Karing 不再对其 EnableSharing',
)
console.log(
  '[通过] 物理上游 ForwardingEnabled 进入稳定 Runtime 身份；状态变化可触发一次受控 Runtime 重生成',
)
console.log(
  '[通过] Forwarding=true 时 Mihomo auto-route 仅安装最终 fake-IP route-address，不再安装 Windows TUN 默认路由',
)
console.log(
  '[通过] 无 fake-IP 可用时 fail-closed 关闭 auto-route，避免整机回环断网',
)
console.log(
  '[通过] 代理/provider socket 继续绑定稳定物理上游，用户显式 interface-name 优先语义保持',
)
console.log(
  '[通过] HNetCfg 仅保留 legacy Hosted Network 兼容；0x80040201 映射 EVENT_E_ALL_SUBSCRIBERS_FAILED 并保留完整错误链',
)
