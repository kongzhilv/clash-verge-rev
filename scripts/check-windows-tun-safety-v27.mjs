import { readFile } from 'node:fs/promises'

// Preserve every v26 invariant first. v27 only changes the active Mobile Hotspot
// ownership strategy; the previous source remains as a historical contract fixture.
await import('./check-windows-tun-safety-v26.mjs')

const files = {
  coreMod: 'src-tauri/src/core/mod.rs',
  hotspot: 'src-tauri/src/core/windows_hotspot_ics_v27.rs',
}

const source = Object.fromEntries(
  await Promise.all(
    Object.entries(files).map(async ([key, path]) => [key, await readFile(path, 'utf8')]),
  ),
)

const failures = []
const requireText = (key, text, label) => {
  if (!source[key].includes(text)) failures.push(`${label}: missing ${text}`)
}
const forbidText = (key, text, label) => {
  if (source[key].includes(text)) failures.push(`${label}: still contains ${text}`)
}

requireText(
  'coreMod',
  '#[path = "windows_hotspot_ics_v27.rs"]',
  'runtime activates the v27 Mobile Hotspot ICS implementation',
)

for (const [marker, label] of [
  ['GetIfTable2', 'adapter inventory uses native IP Helper'],
  ['GetUnicastIpAddressTable', 'hotspot addressing uses native IP Helper'],
  ['InterfaceGuid', 'adapter identity is GUID based'],
  ['target-identification-ambiguous', 'ambiguous adapter discovery fails closed'],
  ['is_mobile_hotspot_adapter', 'modern Wi-Fi Direct/Mobile Hotspot is an eligible private side'],
  ['ICSSHARINGTYPE_PRIVATE', 'hotspot private ICS role is explicit'],
  ['ICSSHARINGTYPE_PUBLIC', 'Mihomo TUN public ICS role is explicit'],
  ['EnableSharing(ICSSHARINGTYPE_PRIVATE)', 'private side uses native HNetCfg COM'],
  ['EnableSharing(ICSSHARINGTYPE_PUBLIC)', 'public side uses native HNetCfg COM'],
  ['save_snapshot', 'original ICS state is persisted before mutation'],
  ['restore_snapshot_unlocked', 'ICS state has a rollback path'],
  ['rollback-immediately', 'failed apply rolls back immediately'],
  ['lease_roles_are_desired', 'post-apply role readback is verified'],
  ['restore_now', 'shutdown/TUN-off explicit restore remains available'],
  ['const LOOP_INTERVAL: Duration = Duration::from_secs(2);', 'hotspot topology is monitored'],
  ['const STABLE_SAMPLES: u8 = 3;', 'topology changes require stable observations'],
  ['hardcoded_upstream_interface', 'diagnostics state that upstream is not hardcoded'],
  ['hardcoded_hotspot_subnet', 'diagnostics state that hotspot subnet is not hardcoded'],
]) {
  requireText('hotspot', marker, label)
}

for (const forbidden of [
  'CMCC-303-5G',
  '192.168.137.0/24',
  '192.168.1.6',
  'ifIndex 23',
  'ifIndex 25',
  'ifIndex 55',
  'powershell.exe',
  'Get-NetAdapter',
  'Get-NetRoute',
  'std::process::Command',
  'hnetcfg_lease_allowed',
  'windows-owned-hotspot-no-hnetcfg-mutation',
  'expect("checked non-empty")',
]) {
  forbidText('hotspot', forbidden, 'v27 remains generic and release-safe')
}

// v27 must remain upgrade-safe for an existing v20 lease rather than orphaning
// an in-flight PUBLIC/PRIVATE topology during application upgrade.
requireText(
  'hotspot',
  'windows-hotspot-ics-lease-v20.json',
  'v27 reuses the existing persistent lease snapshot path',
)
requireText(
  'hotspot',
  'snapshot.version != 2 && snapshot.version != 3',
  'v27 accepts both historical and current snapshot versions',
)

if (failures.length) {
  console.error('[windows-tun-safety-v27] FAILED')
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}

console.log('[windows-tun-safety-v27] OK')
