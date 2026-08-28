import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const fail = (message) => {
  console.error(`windows-hotspot-v22 gate failed: ${message}`);
  process.exit(1);
};
const expect = (condition, message) => {
  if (!condition) fail(message);
};

const cargo = read('src-tauri/Cargo.toml');
const coreMod = read('src-tauri/src/core/mod.rs');
const winrt = read('src-tauri/src/core/windows_hotspot_tethering.rs');
const legacy = read('src-tauri/src/core/windows_hotspot_ics.rs');
const manager = read('src-tauri/src/core/manager/mod.rs');
const shutdown = read('src-tauri/src/feat/window.rs');

for (const feature of ['"Networking"', '"Networking_Connectivity"', '"Networking_NetworkOperators"']) {
  expect(cargo.includes(feature), `missing windows-rs feature ${feature}`);
}
expect(coreMod.includes('windows_hotspot_ics_legacy'), 'legacy HNetCfg module must remain available');
expect(coreMod.includes('pub use windows_hotspot_tethering as windows_hotspot_ics'), 'existing lifecycle API must route to WinRT implementation');
expect(manager.includes('windows_hotspot_ics::ensure_monitor_running()'), 'CoreManager must still start hotspot monitor');
expect(shutdown.includes('windows_hotspot_ics::restore_now("shutdown")'), 'shutdown must restore hotspot before TUN/core teardown');

for (const marker of [
  'NetworkOperatorTetheringManager::CreateFromConnectionProfile',
  'GetTetheringCapabilityFromConnectionProfile',
  'NetworkAdapterId()',
  'StopTetheringAsync()',
  'StartTetheringAsync()',
  'TetheringOperationalState::On',
  'TetheringOperationalState::Off',
  'TetheringCapability::Enabled',
  '.join()',
  'windows-hotspot-winrt-lease-v22.json',
  'rehome-start-failed-rollback',
  'rollback-failed-safe-off',
  'lease-drift-fail-closed',
  'respect-user-hotspot-off',
  'RETRY_COOLDOWN',
  'ClientCount()',
]) {
  expect(winrt.includes(marker), `missing WinRT safety marker: ${marker}`);
}

expect(!winrt.includes('EnableSharing('), 'WinRT primary path must not mutate HNetCfg sharing roles');
expect(!winrt.includes('NetSharingManager'), 'WinRT primary path must not instantiate HNetCfg NetSharingManager');
expect(legacy.includes('EnableSharing(') && legacy.includes('NetSharingManager'), 'legacy HNetCfg fallback unexpectedly removed');
expect(winrt.includes('CLASH_VERGE_HOTSPOT_LEGACY_ICS'), 'legacy fallback must be explicit opt-in');
expect(winrt.includes('mihomo_adapter_guid()'), 'Mihomo profile must derive from adapter identity');
expect(winrt.includes('profile_guid(mihomo_profile)') || winrt.includes('find_profile_by_guid(&profiles, tun_guid)'), 'Mihomo ConnectionProfile must be matched by TUN adapter GUID');

for (const testName of [
  'reconcile_is_fail_closed_when_active_state_is_ambiguous',
  'reconcile_does_not_open_a_hotspot_the_user_left_off',
  'reconcile_rehomes_a_single_physical_upstream',
  'reconcile_keeps_an_already_mihomo_backed_hotspot',
  'reconcile_fails_closed_without_mihomo_profile',
]) {
  expect(winrt.includes(testName), `missing decision regression test ${testName}`);
}

console.log('windows-hotspot-v22 gate passed: WinRT profile/GUID matching, rollback, ownership restore, fail-closed and legacy fallback are pinned.');
