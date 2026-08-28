use std::{
    ffi::c_void,
    fs,
    path::{Path, PathBuf},
    ptr::null_mut,
    slice,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context as _, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::json;
use windows::{
    Networking::{
        Connectivity::{ConnectionProfile, NetworkInformation},
        NetworkOperators::{
            NetworkOperatorTetheringManager, TetheringCapability, TetheringOperationStatus,
            TetheringOperationalState,
        },
    },
    Win32::NetworkManagement::{
        IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_ROW2, MIB_IF_TABLE2},
        Ndis::IfOperStatusUp,
    },
    core::GUID,
};

use crate::{config::Config, core::diagnostics, process::AsyncHandler, utils::dirs};

const LOOP_INTERVAL: Duration = Duration::from_secs(2);
const STABLE_SAMPLES: u8 = 3;
const RETRY_COOLDOWN: Duration = Duration::from_secs(30);
const STATE_WAIT_TIMEOUT: Duration = Duration::from_secs(12);
const STATE_WAIT_INTERVAL: Duration = Duration::from_millis(250);
const SNAPSHOT_FILE: &str = "windows-hotspot-winrt-lease-v22.json";
const LEGACY_FALLBACK_ENV: &str = "CLASH_VERGE_HOTSPOT_LEGACY_ICS";

static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);
static RESTORE_REQUESTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct TetheringLease {
    version: u8,
    created_unix_ms: u128,
    owned: bool,
    hotspot_was_on: bool,
    mihomo_profile_guid: String,
    mihomo_profile_name: String,
    original_profile_guid: String,
    original_profile_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ProfileLog {
    guid: String,
    name: String,
    capability: String,
    state: String,
    client_count: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReconcileDecision {
    Noop,
    Rehome,
    AlreadyDesired,
    FailClosed,
}

fn legacy_fallback_enabled() -> bool {
    std::env::var(LEGACY_FALLBACK_ENV)
        .ok()
        .is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

fn utf16z(value: &[u16]) -> String {
    let len = value.iter().position(|item| *item == 0).unwrap_or(value.len());
    String::from_utf16_lossy(&value[..len])
}

fn interface_identity(row: &MIB_IF_ROW2) -> String {
    format!("{} {}", utf16z(&row.Alias), utf16z(&row.Description)).to_lowercase()
}

fn is_filter_component(identity: &str) -> bool {
    [
        "wfp native mac layer",
        "wfp 802.3 mac layer",
        "native wifi filter driver",
        "virtual wifi filter driver",
        "qos packet scheduler",
        "lightweight filter",
    ]
    .iter()
    .any(|marker| identity.contains(marker))
}

fn is_mihomo_tun(row: &MIB_IF_ROW2) -> bool {
    if row.OperStatus != IfOperStatusUp {
        return false;
    }
    let identity = interface_identity(row);
    !is_filter_component(&identity)
        && (identity.contains("meta tunnel")
            || identity.contains("mihomo")
            || identity.contains("wintun") && identity.contains("clash"))
}

fn load_interfaces() -> Result<Vec<MIB_IF_ROW2>> {
    let mut table: *mut MIB_IF_TABLE2 = null_mut();
    let status = unsafe { GetIfTable2(&mut table) };
    if status.0 != 0 || table.is_null() {
        bail!("GetIfTable2 failed with Windows error {}", status.0);
    }
    let rows = unsafe {
        let table_ref = &*table;
        slice::from_raw_parts(table_ref.Table.as_ptr(), table_ref.NumEntries as usize).to_vec()
    };
    unsafe { FreeMibTable(table.cast::<c_void>()) };
    Ok(rows)
}

fn mihomo_adapter_guid() -> Result<Option<GUID>> {
    let candidates = load_interfaces()?
        .into_iter()
        .filter(is_mihomo_tun)
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok(None);
    }
    if candidates.len() != 1 {
        diagnostics::warn(
            "windows-hotspot-winrt",
            "mihomo-adapter-ambiguous",
            json!({
                "candidates": candidates.iter().map(|row| json!({
                    "guid": guid_string(row.InterfaceGuid),
                    "alias": utf16z(&row.Alias),
                    "description": utf16z(&row.Description),
                })).collect::<Vec<_>>(),
                "action": "fail-closed-no-tethering-mutation",
            }),
        );
        return Ok(None);
    }
    Ok(Some(candidates[0].InterfaceGuid))
}

fn guid_string(guid: GUID) -> String {
    format!("{guid:?}").to_ascii_lowercase()
}

fn normalize_guid(value: &str) -> String {
    value.trim().trim_matches(['{', '}']).to_ascii_lowercase()
}

fn same_guid(left: &str, right: GUID) -> bool {
    normalize_guid(left) == normalize_guid(&guid_string(right))
}

fn snapshot_path() -> Result<PathBuf> {
    Ok(dirs::app_home_dir()?.join(SNAPSHOT_FILE))
}

fn save_lease(path: &Path, lease: &TetheringLease) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    let _ = fs::remove_file(&temporary);
    fs::write(&temporary, serde_json::to_vec_pretty(lease)?)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn load_lease(path: &Path) -> Result<Option<TetheringLease>> {
    match fs::read(path) {
        Ok(bytes) => {
            let lease: TetheringLease = serde_json::from_slice(&bytes)?;
            if lease.version != 22 {
                bail!("unsupported Windows hotspot WinRT lease version {}", lease.version);
            }
            Ok(Some(lease))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn remove_lease(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn profile_guid(profile: &ConnectionProfile) -> Result<GUID> {
    profile
        .NetworkAdapter()
        .context("ConnectionProfile::NetworkAdapter failed")?
        .NetworkAdapterId()
        .context("NetworkAdapter::NetworkAdapterId failed")
}

fn profile_name(profile: &ConnectionProfile) -> String {
    profile.ProfileName().map(|value| value.to_string_lossy()).unwrap_or_else(|_| "<unknown>".to_string())
}

fn all_profiles() -> Result<Vec<ConnectionProfile>> {
    let profiles = NetworkInformation::GetConnectionProfiles().context("NetworkInformation::GetConnectionProfiles failed")?;
    let mut result = Vec::with_capacity(profiles.Size()? as usize);
    for index in 0..profiles.Size()? {
        result.push(profiles.GetAt(index)?);
    }
    Ok(result)
}

fn find_profile_by_guid<'a>(profiles: &'a [ConnectionProfile], guid: GUID) -> Result<Option<&'a ConnectionProfile>> {
    for profile in profiles {
        if profile_guid(profile).is_ok_and(|candidate| candidate == guid) {
            return Ok(Some(profile));
        }
    }
    Ok(None)
}

fn find_profile_by_saved_identity<'a>(
    profiles: &'a [ConnectionProfile],
    guid: &str,
    name: &str,
) -> Result<Option<&'a ConnectionProfile>> {
    let mut guid_match = None;
    for profile in profiles {
        let candidate = match profile_guid(profile) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if same_guid(guid, candidate) {
            if profile_name(profile) == name {
                return Ok(Some(profile));
            }
            guid_match = Some(profile);
        }
    }
    Ok(guid_match)
}

fn capability_name(value: TetheringCapability) -> String {
    format!("{value:?}")
}

fn state_name(value: TetheringOperationalState) -> String {
    format!("{value:?}")
}

fn manager_for(profile: &ConnectionProfile) -> Result<NetworkOperatorTetheringManager> {
    NetworkOperatorTetheringManager::CreateFromConnectionProfile(profile)
        .context("NetworkOperatorTetheringManager::CreateFromConnectionProfile failed")
}

fn operation_succeeded(status: TetheringOperationStatus, target_on: bool) -> bool {
    status == TetheringOperationStatus::Success
        || target_on && status == TetheringOperationStatus::AlreadyOn
}

fn wait_for_state(
    manager: &NetworkOperatorTetheringManager,
    expected: TetheringOperationalState,
) -> Result<()> {
    let deadline = Instant::now() + STATE_WAIT_TIMEOUT;
    loop {
        let state = manager.TetheringOperationalState()?;
        if state == expected {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("timed out waiting for tethering state {expected:?}; observed {state:?}");
        }
        std::thread::sleep(STATE_WAIT_INTERVAL);
    }
}

fn stop_manager(manager: &NetworkOperatorTetheringManager, label: &str) -> Result<()> {
    if manager.TetheringOperationalState()? == TetheringOperationalState::Off {
        return Ok(());
    }
    let result = manager
        .StopTetheringAsync()
        .context("StopTetheringAsync creation failed")?
        .join()
        .context("StopTetheringAsync join failed")?;
    let status = result.Status()?;
    let message = result.AdditionalErrorMessage()?.to_string_lossy();
    diagnostics::info(
        "windows-hotspot-winrt",
        "stop-result",
        json!({"profile": label, "status": format!("{status:?}"), "additional_error": message}),
    );
    if !operation_succeeded(status, false) {
        bail!("StopTetheringAsync failed for {label}: {status:?}: {message}");
    }
    wait_for_state(manager, TetheringOperationalState::Off)
}

fn start_manager(manager: &NetworkOperatorTetheringManager, label: &str) -> Result<()> {
    let result = manager
        .StartTetheringAsync()
        .context("StartTetheringAsync creation failed")?
        .join()
        .context("StartTetheringAsync join failed")?;
    let status = result.Status()?;
    let message = result.AdditionalErrorMessage()?.to_string_lossy();
    diagnostics::info(
        "windows-hotspot-winrt",
        "start-result",
        json!({"profile": label, "status": format!("{status:?}"), "additional_error": message}),
    );
    if !operation_succeeded(status, true) {
        bail!("StartTetheringAsync failed for {label}: {status:?}: {message}");
    }
    wait_for_state(manager, TetheringOperationalState::On)
}

fn profile_logs(profiles: &[ConnectionProfile]) -> Vec<ProfileLog> {
    profiles
        .iter()
        .filter_map(|profile| {
            let guid = profile_guid(profile).ok()?;
            let capability = NetworkOperatorTetheringManager::GetTetheringCapabilityFromConnectionProfile(profile).ok()?;
            let manager = manager_for(profile).ok()?;
            let state = manager.TetheringOperationalState().ok()?;
            Some(ProfileLog {
                guid: guid_string(guid),
                name: profile_name(profile),
                capability: capability_name(capability),
                state: state_name(state),
                client_count: manager.ClientCount().ok(),
            })
        })
        .collect()
}

fn active_profiles<'a>(profiles: &'a [ConnectionProfile]) -> Result<Vec<&'a ConnectionProfile>> {
    let mut active = Vec::new();
    for profile in profiles {
        let manager = match manager_for(profile) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if manager.TetheringOperationalState()? == TetheringOperationalState::On {
            active.push(profile);
        }
    }
    Ok(active)
}

fn decide_reconcile(active_count: usize, active_is_mihomo: bool, mihomo_available: bool) -> ReconcileDecision {
    if !mihomo_available || active_count > 1 {
        ReconcileDecision::FailClosed
    } else if active_count == 0 {
        ReconcileDecision::Noop
    } else if active_is_mihomo {
        ReconcileDecision::AlreadyDesired
    } else {
        ReconcileDecision::Rehome
    }
}

fn restore_owned_lease(path: &Path, reason: &str) -> Result<bool> {
    let Some(lease) = load_lease(path)? else {
        return Ok(false);
    };
    if !lease.owned {
        remove_lease(path)?;
        return Ok(false);
    }

    let profiles = all_profiles()?;
    diagnostics::info(
        "windows-hotspot-winrt",
        "restore-started",
        json!({"reason": reason, "lease": lease, "profiles": profile_logs(&profiles)}),
    );

    if let Some(mihomo) = find_profile_by_saved_identity(
        &profiles,
        &lease.mihomo_profile_guid,
        &lease.mihomo_profile_name,
    )? {
        let manager = manager_for(mihomo)?;
        if manager.TetheringOperationalState()? != TetheringOperationalState::Off {
            stop_manager(&manager, &profile_name(mihomo))?;
        }
    }

    let mut original_restored = false;
    if lease.hotspot_was_on {
        if let Some(original) = find_profile_by_saved_identity(
            &profiles,
            &lease.original_profile_guid,
            &lease.original_profile_name,
        )? {
            let manager = manager_for(original)?;
            start_manager(&manager, &profile_name(original))?;
            original_restored = true;
        } else {
            diagnostics::warn(
                "windows-hotspot-winrt",
                "original-profile-missing-safe-off",
                json!({
                    "original_profile_guid": lease.original_profile_guid,
                    "original_profile_name": lease.original_profile_name,
                    "action": "leave-hotspot-off-before-tun-removal",
                }),
            );
        }
    }

    remove_lease(path)?;
    diagnostics::info(
        "windows-hotspot-winrt",
        "lease-restored",
        json!({"reason": reason, "original_restored": original_restored}),
    );
    Ok(true)
}

fn reconcile_once(tun_enabled: bool, path: &Path) -> Result<&'static str> {
    if !tun_enabled || RESTORE_REQUESTED.load(Ordering::Acquire) {
        return if restore_owned_lease(path, "tun-disabled-or-restore-requested")? {
            Ok("restored")
        } else {
            Ok("inactive")
        };
    }

    let Some(tun_guid) = mihomo_adapter_guid()? else {
        return Ok("mihomo-missing");
    };
    let profiles = all_profiles()?;
    let Some(mihomo_profile) = find_profile_by_guid(&profiles, tun_guid)? else {
        diagnostics::warn(
            "windows-hotspot-winrt",
            "mihomo-connection-profile-missing",
            json!({"tun_guid": guid_string(tun_guid), "profiles": profile_logs(&profiles)}),
        );
        return Ok("mihomo-profile-missing");
    };

    let capability = NetworkOperatorTetheringManager::GetTetheringCapabilityFromConnectionProfile(mihomo_profile)?;
    if capability != TetheringCapability::Enabled {
        diagnostics::warn(
            "windows-hotspot-winrt",
            "mihomo-tethering-capability-disabled",
            json!({
                "tun_guid": guid_string(tun_guid),
                "profile": profile_name(mihomo_profile),
                "capability": capability_name(capability),
                "action": "fail-closed-no-hotspot-mutation",
            }),
        );
        return Ok("capability-disabled");
    }

    let active = active_profiles(&profiles)?;
    let active_is_mihomo = active.len() == 1 && profile_guid(active[0])? == tun_guid;
    match decide_reconcile(active.len(), active_is_mihomo, true) {
        ReconcileDecision::FailClosed => {
            diagnostics::warn(
                "windows-hotspot-winrt",
                "active-tethering-ambiguous",
                json!({"profiles": profile_logs(&profiles), "action": "fail-closed-no-hotspot-mutation"}),
            );
            Ok("ambiguous")
        }
        ReconcileDecision::Noop => {
            if load_lease(path)?.is_some() {
                // User turning Mobile Hotspot off is authoritative. Do not reopen it during reconciliation.
                remove_lease(path)?;
                diagnostics::info(
                    "windows-hotspot-winrt",
                    "lease-released-hotspot-off",
                    json!({"action": "respect-user-hotspot-off"}),
                );
            }
            Ok("hotspot-off")
        }
        ReconcileDecision::AlreadyDesired => Ok("already-mihomo"),
        ReconcileDecision::Rehome => {
            let original = active[0];
            let original_guid = profile_guid(original)?;
            let original_name = profile_name(original);
            let mihomo_name = profile_name(mihomo_profile);

            if let Some(existing) = load_lease(path)? {
                if !same_guid(&existing.original_profile_guid, original_guid) {
                    diagnostics::warn(
                        "windows-hotspot-winrt",
                        "lease-drift-fail-closed",
                        json!({
                            "saved_original_guid": existing.original_profile_guid,
                            "observed_original_guid": guid_string(original_guid),
                            "action": "fail-closed-preserve-existing-lease",
                        }),
                    );
                    return Ok("lease-drift");
                }
            }

            let lease = TetheringLease {
                version: 22,
                created_unix_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
                owned: true,
                hotspot_was_on: true,
                mihomo_profile_guid: guid_string(tun_guid),
                mihomo_profile_name: mihomo_name.clone(),
                original_profile_guid: guid_string(original_guid),
                original_profile_name: original_name.clone(),
            };
            save_lease(path, &lease)?;
            diagnostics::info(
                "windows-hotspot-winrt",
                "rehome-started",
                json!({
                    "original_profile": original_name,
                    "original_guid": guid_string(original_guid),
                    "mihomo_profile": mihomo_name,
                    "mihomo_guid": guid_string(tun_guid),
                    "profiles_before": profile_logs(&profiles),
                }),
            );

            let original_manager = manager_for(original)?;
            stop_manager(&original_manager, &original_name)?;

            let mihomo_manager = manager_for(mihomo_profile)?;
            if let Err(start_error) = start_manager(&mihomo_manager, &mihomo_name) {
                diagnostics::error(
                    "windows-hotspot-winrt",
                    "rehome-start-failed-rollback",
                    json!({"error": start_error.to_string(), "rollback_profile": original_name}),
                );
                let rollback = start_manager(&original_manager, &original_name);
                if rollback.is_ok() {
                    remove_lease(path)?;
                    bail!("Mihomo tethering start failed and original hotspot was restored: {start_error}");
                }
                diagnostics::error(
                    "windows-hotspot-winrt",
                    "rollback-failed-safe-off",
                    json!({
                        "start_error": start_error.to_string(),
                        "rollback_error": rollback.as_ref().err().map(ToString::to_string),
                        "action": "leave-hotspot-off-preserve-lease-for-next-restore",
                    }),
                );
                return Err(anyhow!(
                    "Mihomo tethering start failed ({start_error}); original hotspot rollback also failed ({})",
                    rollback.unwrap_err()
                ));
            }

            let state = mihomo_manager.TetheringOperationalState()?;
            let clients = mihomo_manager.ClientCount().ok();
            if state != TetheringOperationalState::On {
                bail!("Mihomo tethering verification failed: state={state:?}");
            }
            diagnostics::info(
                "windows-hotspot-winrt",
                "rehome-verified",
                json!({
                    "mihomo_guid": guid_string(tun_guid),
                    "state": state_name(state),
                    "client_count": clients,
                    "control_plane": "NetworkOperatorTetheringManager",
                }),
            );
            Ok("rehome-verified")
        }
    }
}

async fn monitor_loop() {
    let path = match snapshot_path() {
        Ok(value) => value,
        Err(error) => {
            diagnostics::error("windows-hotspot-winrt", "snapshot-path-failed", json!({"error": error.to_string()}));
            return;
        }
    };
    diagnostics::info(
        "windows-hotspot-winrt",
        "monitor-started",
        json!({
            "poll_interval_ms": LOOP_INTERVAL.as_millis(),
            "stable_samples": STABLE_SAMPLES,
            "retry_cooldown_ms": RETRY_COOLDOWN.as_millis(),
            "snapshot": path,
            "legacy_hnetcfg": false,
        }),
    );

    let mut interval = tokio::time::interval(LOOP_INTERVAL);
    let mut last_signature = String::new();
    let mut stable_count = 0u8;
    let mut last_outcome = String::new();
    let mut last_error = String::new();
    let mut retry_after: Option<Instant> = None;

    loop {
        interval.tick().await;
        let tun_enabled = Config::verge().await.latest_arc().enable_tun_mode.unwrap_or(false);
        let restore_requested = RESTORE_REQUESTED.load(Ordering::Acquire);

        let signature = tokio::task::spawn_blocking(move || -> Result<String> {
            if !tun_enabled || restore_requested {
                return Ok(format!("restore:{tun_enabled}:{restore_requested}"));
            }
            Ok(match mihomo_adapter_guid()? {
                Some(guid) => format!("active:{}", guid_string(guid)),
                None => "active:none".to_string(),
            })
        })
        .await;
        let signature = match signature {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                let message = error.to_string();
                if message != last_error {
                    diagnostics::warn("windows-hotspot-winrt", "signature-failed", json!({"error": message}));
                    last_error = message;
                }
                continue;
            }
            Err(error) => {
                let message = error.to_string();
                if message != last_error {
                    diagnostics::error("windows-hotspot-winrt", "signature-task-failed", json!({"error": message}));
                    last_error = message;
                }
                continue;
            }
        };

        if signature == last_signature {
            stable_count = stable_count.saturating_add(1);
        } else {
            last_signature = signature;
            stable_count = 1;
            retry_after = None;
        }
        if stable_count < STABLE_SAMPLES {
            continue;
        }
        if retry_after.is_some_and(|deadline| Instant::now() < deadline) {
            continue;
        }

        let path_for_task = path.clone();
        let outcome = tokio::task::spawn_blocking(move || reconcile_once(tun_enabled, &path_for_task)).await;
        match outcome {
            Ok(Ok(outcome)) => {
                last_error.clear();
                retry_after = None;
                if outcome != last_outcome {
                    diagnostics::info("windows-hotspot-winrt", "reconcile-completed", json!({"outcome": outcome}));
                    last_outcome = outcome.to_string();
                }
            }
            Ok(Err(error)) => {
                let message = error.to_string();
                retry_after = Some(Instant::now() + RETRY_COOLDOWN);
                if message != last_error {
                    diagnostics::error(
                        "windows-hotspot-winrt",
                        "reconcile-failed",
                        json!({"error": message, "retry_cooldown_ms": RETRY_COOLDOWN.as_millis()}),
                    );
                    last_error = message;
                }
            }
            Err(error) => {
                let message = error.to_string();
                retry_after = Some(Instant::now() + RETRY_COOLDOWN);
                if message != last_error {
                    diagnostics::error(
                        "windows-hotspot-winrt",
                        "reconcile-task-failed",
                        json!({"error": message, "retry_cooldown_ms": RETRY_COOLDOWN.as_millis()}),
                    );
                    last_error = message;
                }
            }
        }
    }
}

pub fn ensure_monitor_running() {
    if legacy_fallback_enabled() {
        diagnostics::warn(
            "windows-hotspot-winrt",
            "legacy-hnetcfg-fallback-enabled",
            json!({"env": LEGACY_FALLBACK_ENV, "control_plane": "HNetCfg"}),
        );
        super::windows_hotspot_ics_legacy::ensure_monitor_running();
        return;
    }
    if MONITOR_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    AsyncHandler::spawn(|| async {
        monitor_loop().await;
    });
}

pub async fn restore_now(reason: &'static str) -> Result<bool> {
    if legacy_fallback_enabled() {
        return super::windows_hotspot_ics_legacy::restore_now(reason).await;
    }
    RESTORE_REQUESTED.store(true, Ordering::Release);
    let path = snapshot_path()?;
    tokio::task::spawn_blocking(move || restore_owned_lease(&path, reason))
        .await
        .map_err(|error| anyhow!("Windows hotspot WinRT restore task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconcile_is_fail_closed_when_active_state_is_ambiguous() {
        assert_eq!(decide_reconcile(2, false, true), ReconcileDecision::FailClosed);
    }

    #[test]
    fn reconcile_does_not_open_a_hotspot_the_user_left_off() {
        assert_eq!(decide_reconcile(0, false, true), ReconcileDecision::Noop);
    }

    #[test]
    fn reconcile_rehomes_a_single_physical_upstream() {
        assert_eq!(decide_reconcile(1, false, true), ReconcileDecision::Rehome);
    }

    #[test]
    fn reconcile_keeps_an_already_mihomo_backed_hotspot() {
        assert_eq!(decide_reconcile(1, true, true), ReconcileDecision::AlreadyDesired);
    }

    #[test]
    fn reconcile_fails_closed_without_mihomo_profile() {
        assert_eq!(decide_reconcile(1, false, false), ReconcileDecision::FailClosed);
    }

    #[test]
    fn guid_normalization_ignores_braces_and_case() {
        let guid = GUID::from_u128(0x12345678_1234_5678_90ab_1234567890ab);
        assert!(same_guid("{12345678-1234-5678-90AB-1234567890AB}", guid));
    }
}