import { readFile } from 'node:fs/promises'

const files = {
  manager: 'src-tauri/src/core/manager/config.rs',
  lifecycle: 'src-tauri/src/core/manager/lifecycle.rs',
  windowsNetwork: 'src-tauri/src/utils/windows_network.rs',
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
  'Windows route inspection does not block the async runtime',
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
requireText(
  'windowsNetwork',
  'Get-NetRoute -AddressFamily IPv4',
  'route guard observes the Windows active IPv4 routing table',
)
requireText(
  'windowsNetwork',
  'wi-?fi direct virtual adapter',
  'Windows hotspot private virtual adapter is excluded from uplink selection',
)
requireText(
  'windowsNetwork',
  'mihomo|clash',
  'proxy virtual adapters are excluded from uplink selection',
)
requireText(
  'windowsNetwork',
  'format!(\n            "{}|{}|{}"',
  'route stability includes interface, source address and gateway',
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
  'utils',
  'pub mod windows_network;',
  'Windows route guard is compiled into the app',
)
forbidText(
  'windowsNetwork',
  'Microsoft Wi-Fi Direct Virtual Adapter"',
  'route filtering should remain case-insensitive and pattern based',
)

if (failures.length > 0) {
  console.error('Windows TUN safety regression failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Windows TUN safety regression passed.')
