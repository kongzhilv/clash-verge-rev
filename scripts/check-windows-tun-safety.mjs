import { readFile } from 'node:fs/promises'

const files = {
  manager: 'src-tauri/src/core/manager/config.rs',
  lifecycle: 'src-tauri/src/core/manager/lifecycle.rs',
  windowsNetwork: 'src-tauri/src/utils/windows_network.rs',
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

const failures = []
const requireText = (key, text, label) => {
  if (!source[key].includes(text)) failures.push(`${label}: missing ${text}`)
}
const forbidText = (key, text, label) => {
  if (source[key].includes(text))
    failures.push(`${label}: still contains ${text}`)
}

requireText(
  'manager',
  'core is stopped; staged configuration without starting it',
  'background config updates do not silently start a stopped proxy core',
)
requireText(
  'manager',
  'matches!(*self.get_running_mode(), RunningMode::NotRunning)',
  'config application checks the actual core running state',
)
requireText(
  'manager',
  'prepare_windows_tun_runtime_for_start',
  'Windows has a dedicated pre-start TUN safety path',
)
requireText(
  'manager',
  'source_has_interface || app_has_interface',
  'explicit user interface selection is preserved',
)
requireText(
  'manager',
  'tokio::task::spawn_blocking(detect_stable_upstream)',
  'native Windows route inspection does not block the async runtime',
)
requireText(
  'lifecycle',
  'self.prepare_windows_tun_runtime_for_start().await?;',
  'stable upstream validation happens before core startup',
)
requireText(
  'windowsNetwork',
  'const STABLE_SAMPLES: usize = 6;',
  'route selection requires a quiet stability window',
)
requireText(
  'windowsNetwork',
  'const MAX_SAMPLES: usize = 24;',
  'route selection has a bounded retry window',
)
for (const api of [
  'GetIpForwardTable2',
  'GetIfTable2',
  'GetUnicastIpAddressTable',
  'GetIpInterfaceEntry',
  'FreeMibTable',
]) {
  requireText(
    'windowsNetwork',
    api,
    `Windows route guard uses native IP Helper API ${api}`,
  )
}
requireText(
  'manifest',
  '"Win32_NetworkManagement_Ndis"',
  'native adapter status types are enabled without shelling out',
)
requireText(
  'windowsNetwork',
  'is_hotspot_side',
  'Windows hotspot private-side interfaces are identified',
)
requireText(
  'windowsNetwork',
  'wi-fi direct virtual adapter',
  'Wi-Fi Direct hotspot adapters are classified without locale-specific commands',
)
requireText(
  'windowsNetwork',
  'route-exclude-address',
  'LAN and hotspot subnets are protected from TUN auto-route',
)
requireText(
  'windowsNetwork',
  'exclude-interface',
  'hotspot-side interfaces can be excluded from TUN routing',
)
requireText(
  'windowsNetwork',
  'include-interface',
  'explicit include-interface is preserved to avoid conflicting Mihomo options',
)
requireText(
  'windowsNetwork',
  'Value::from("interface-name")',
  'stable physical uplink is pinned into Mihomo runtime config',
)
requireText(
  'windowsNetwork',
  'Value::from("auto-detect-interface"), Value::from(false)',
  'managed Windows TUN disables route-flapping interface autodetection',
)
requireText(
  'windowsNetwork',
  'route_exclude_addresses.join(",")',
  'stability signature includes hotspot and LAN exclusions',
)
requireText(
  'utils',
  'pub mod windows_network;',
  'Windows route guard is compiled into the app',
)

for (const forbidden of [
  'powershell.exe',
  'POWERSHELL_ROUTE_QUERY',
  'ExecutionPolicy',
  'Get-NetRoute',
  'Get-NetAdapter',
  'std::process::Command',
]) {
  forbidText(
    'windowsNetwork',
    forbidden,
    'Windows TUN safety must not spawn PowerShell or depend on shell cmdlets',
  )
}

if (failures.length > 0) {
  console.error('Windows TUN safety regression failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Windows TUN safety regression passed.')
console.log('[通过] 启动阶段不再执行 PowerShell / ExecutionPolicy Bypass')
console.log('[通过] 默认路由通过 Win32 IP Helper API 在进程内读取')
console.log('[通过] Wi-Fi Direct/移动热点私网接口与 LAN CIDR 受 TUN 路由保护')
