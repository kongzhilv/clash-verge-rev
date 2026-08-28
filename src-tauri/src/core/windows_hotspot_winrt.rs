use std::{
    ffi::c_void,
    ptr::null_mut,
    slice,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context as _, Result, anyhow, bail};
use serde_json::json;
use windows::{
    Networking::{
        Connectivity::{ConnectionProfile, NetworkConnectivityLevel, NetworkInformation},
        NetworkOperators::{
            NetworkOperatorTetheringManager, NetworkOperatorTetheringOperationResult, TetheringOperationalState,
            TetheringOperationStatus,
        },
    },
    Win32::{
        NetworkManagement::{
            IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_ROW2, MIB_IF_TABLE2},
            Ndis::IfOperStatusUp,
        },
        System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize},
    },
    core::GUID,
};

use crate::{config::Config, core::diagnostics, process::AsyncHandler};

const LOOP_INTERVAL: Duration = Duration::from_secs(2);
static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);
static LEASE_ACTIVE: AtomicBool = AtomicBool::new(false);
static RESTORE_PENDING: AtomicBool = AtomicBool::new(false);
static TEARDOWN_SUPPRESSED: AtomicBool = AtomicBool::new(false);
static MUTATION_LOCK: Mutex<()> = Mutex::new(());

struct WinRtApartment;

impl WinRtApartment {
    fn init() -> Result<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.context("RoInitialize(RO_INIT_MULTITHREADED) failed")?;
        Ok(Self)
    }
}

impl Drop for WinRtApartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
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

fn mihomo_tun_guid() -> Result<Option<GUID>> {
    let mut candidates = load_interfaces()?
        .into_iter()
        .filter(is_mihomo_tun)
        .map(|row| row.InterfaceGuid)
        .collect::<Vec<_>>();
    candidates.sort_by_key(|guid| format!("{guid:?}"));
    candidates.dedup();
    match candidates.len() {
        0 => Ok(None),
        1 => Ok(candidates.pop()),
        _ => {
            diagnostics::warn(
                "windows-hotspot-winrt",
                "tun-identification-ambiguous",
                json!({
                    "candidate_guids": candidates.iter().map(|guid| format!("{guid:?}")).collect::<Vec<_>>(),
                    "action": "fail-closed-no-hotspot-mutation",
                }),
            );
            Ok(None)
        }
    }
}

fn profile_adapter_id(profile: &ConnectionProfile) -> Result<GUID> {
    profile
        .NetworkAdapter()
        .context("ConnectionProfile::NetworkAdapter failed")?
        .NetworkAdapterId()
        .context("NetworkAdapter::NetworkAdapterId failed")
}

fn connection_profiles() -> Result<Vec<ConnectionProfile>> {
    let profiles = NetworkInformation::GetConnectionProfiles().context("GetConnectionProfiles failed")?;
    let size = profiles.Size().context("ConnectionProfiles::Size failed")?;
    let mut result = Vec::with_capacity(size as usize);
    for index in 0..size {
        result.push(profiles.GetAt(index).context("ConnectionProfiles::GetAt failed")?);
    }
    Ok(result)
}

fn find_tun_profile(tun_guid: GUID) -> Result<Option<ConnectionProfile>> {
    for profile in connection_profiles()? {
        if profile_adapter_id(&profile).ok() == Some(tun_guid) {
            return Ok(Some(profile));
        }
    }
    Ok(None)
}

fn connectivity_score(level: NetworkConnectivityLevel) -> i32 {
    if level == NetworkConnectivityLevel::InternetAccess {
        40
    } else if level == NetworkConnectivityLevel::ConstrainedInternetAccess {
        30
    } else if level == NetworkConnectivityLevel::LocalAccess {
        10
    } else {
        0
    }
}

fn best_physical_profile(excluded_guid: Option<GUID>) -> Result<Option<ConnectionProfile>> {
    let mut best: Option<(i32, String, ConnectionProfile)> = None;
    for profile in connection_profiles()? {
        let Ok(adapter_id) = profile_adapter_id(&profile) else {
            continue;
        };
        if excluded_guid == Some(adapter_id) {
            continue;
        }
        let name = profile.ProfileName().map(|value| value.to_string()).unwrap_or_default();
        let level = profile
            .GetNetworkConnectivityLevel()
            .unwrap_or(NetworkConnectivityLevel::None);
        let mut score = connectivity_score(level);
        if profile.IsWlanConnectionProfile().unwrap_or(false) {
            score += 3;
        }
        if score == 0 {
            continue;
        }
        let replace = best
            .as_ref()
            .is_none_or(|(best_score, best_name, _)| score > *best_score || score == *best_score && name < *best_name);
        if replace {
            best = Some((score, name, profile));
        }
    }
    Ok(best.map(|(_, _, profile)| profile))
}

fn operation_details(result: &NetworkOperatorTetheringOperationResult) -> (TetheringOperationStatus, String) {
    let status = result.Status().unwrap_or(TetheringOperationStatus::Unknown);
    let message = result
        .AdditionalErrorMessage()
        .map(|value| value.to_string())
        .unwrap_or_default();
    (status, message)
}

fn stop_tethering(manager: &NetworkOperatorTetheringManager, reason: &'static str) -> Result<()> {
    if manager.TetheringOperationalState()? == TetheringOperationalState::Off {
        return Ok(());
    }
    let result = manager
        .StopTetheringAsync()
        .context("StopTetheringAsync dispatch failed")?
        .join()
        .context("StopTetheringAsync completion failed")?;
    let (status, additional_error) = operation_details(&result);
    diagnostics::info(
        "windows-hotspot-winrt",
        "stop-result",
        json!({
            "reason": reason,
            "status": format!("{status:?}"),
            "status_code": status.0,
            "additional_error": additional_error,
        }),
    );
    if status != TetheringOperationStatus::Success {
        bail!("StopTetheringAsync returned {status:?}: {additional_error}");
    }
    Ok(())
}

fn start_tethering(manager: &NetworkOperatorTetheringManager, reason: &'static str) -> Result<()> {
    let result = manager
        .StartTetheringAsync()
        .context("StartTetheringAsync dispatch failed")?
        .join()
        .context("StartTetheringAsync completion failed")?;
    let (status, additional_error) = operation_details(&result);
    let final_state = manager.TetheringOperationalState()?;
    diagnostics::info(
        "windows-hotspot-winrt",
        "start-result",
        json!({
            "reason": reason,
            "status": format!("{status:?}"),
            "status_code": status.0,
            "additional_error": additional_error,
            "final_state": format!("{final_state:?}"),
            "client_count": manager.ClientCount().ok(),
        }),
    );
    if status != TetheringOperationStatus::Success && status != TetheringOperationStatus::AlreadyOn {
        bail!("StartTetheringAsync returned {status:?}: {additional_error}");
    }
    if final_state != TetheringOperationalState::On {
        bail!("hotspot did not reach On after StartTetheringAsync: {final_state:?}");
    }
    Ok(())
}

fn fallback_to_physical(profile: Option<ConnectionProfile>, reason: &'static str) -> Result<bool> {
    let Some(profile) = profile else {
        return Ok(false);
    };
    let manager = NetworkOperatorTetheringManager::CreateFromConnectionProfile(&profile)
        .context("CreateFromConnectionProfile(physical fallback) failed")?;
    stop_tethering(&manager, reason)?;
    start_tethering(&manager, reason)?;
    Ok(true)
}

fn reconcile_tun_hotspot() -> Result<&'static str> {
    if TEARDOWN_SUPPRESSED.load(Ordering::Acquire) {
        return Ok("teardown-suppressed");
    }
    let _guard = MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow!("Windows WinRT hotspot mutation lock was poisoned"))?;
    let _apartment = WinRtApartment::init()?;

    let Some(tun_guid) = mihomo_tun_guid()? else {
        return Ok("tun-not-found");
    };
    let Some(tun_profile) = find_tun_profile(tun_guid)? else {
        return Ok("tun-profile-not-found");
    };

    let capability = NetworkOperatorTetheringManager::GetTetheringCapabilityFromConnectionProfile(&tun_profile)
        .context("GetTetheringCapabilityFromConnectionProfile(Mihomo) failed")?;
    let manager = NetworkOperatorTetheringManager::CreateFromConnectionProfile(&tun_profile)
        .context("CreateFromConnectionProfile(Mihomo) failed")?;
    let state = manager.TetheringOperationalState()?;

    diagnostics::info(
        "windows-hotspot-winrt",
        "probe",
        json!({
            "profile_name": tun_profile.ProfileName().map(|value| value.to_string()).unwrap_or_default(),
            "tun_guid": format!("{tun_guid:?}"),
            "capability": format!("{capability:?}"),
            "operational_state": format!("{state:?}"),
            "lease_active": LEASE_ACTIVE.load(Ordering::Acquire),
        }),
    );

    if state == TetheringOperationalState::Off {
        LEASE_ACTIVE.store(false, Ordering::Release);
        RESTORE_PENDING.store(false, Ordering::Release);
        return Ok("hotspot-off");
    }
    if state == TetheringOperationalState::InTransition {
        return Ok("hotspot-in-transition");
    }
    if LEASE_ACTIVE.load(Ordering::Acquire) {
        return Ok("winrt-lease-already-active");
    }

    let fallback_profile = best_physical_profile(Some(tun_guid))?;
    stop_tethering(&manager, "rebind-mihomo-public")?;
    if let Err(error) = start_tethering(&manager, "rebind-mihomo-public") {
        diagnostics::error(
            "windows-hotspot-winrt",
            "mihomo-start-failed",
            json!({
                "error": error.to_string(),
                "action": "attempt-immediate-physical-fallback",
            }),
        );
        match fallback_to_physical(fallback_profile, "rollback-after-mihomo-start-failure") {
            Ok(true) => diagnostics::info(
                "windows-hotspot-winrt",
                "physical-fallback-restored",
                json!({"reason": "mihomo-start-failed"}),
            ),
            Ok(false) => diagnostics::error(
                "windows-hotspot-winrt",
                "physical-fallback-unavailable",
                json!({"reason": "mihomo-start-failed"}),
            ),
            Err(restore_error) => diagnostics::error(
                "windows-hotspot-winrt",
                "physical-fallback-failed",
                json!({"error": restore_error.to_string()}),
            ),
        }
        return Err(error);
    }

    LEASE_ACTIVE.store(true, Ordering::Release);
    RESTORE_PENDING.store(false, Ordering::Release);
    diagnostics::info(
        "windows-hotspot-winrt",
        "lease-applied",
        json!({
            "strategy": "network-operator-tethering-manager",
            "public_profile_guid": format!("{tun_guid:?}"),
            "public_profile_name": tun_profile.ProfileName().map(|value| value.to_string()).unwrap_or_default(),
            "private_interface": "wifi-managed-by-windows",
            "sequence": "stop-existing-then-start-from-mihomo-profile",
            "legacy_hnetcfg_mutation": false,
        }),
    );
    Ok("winrt-lease-applied")
}

fn restore_to_physical(reason: &'static str) -> Result<bool> {
    let _guard = MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow!("Windows WinRT hotspot mutation lock was poisoned"))?;
    let _apartment = WinRtApartment::init()?;
    let excluded = mihomo_tun_guid().ok().flatten();
    let physical = best_physical_profile(excluded)?
        .ok_or_else(|| anyhow!("no physical ConnectionProfile is available for hotspot restore"))?;
    let profile_name = physical.ProfileName().map(|value| value.to_string()).unwrap_or_default();
    let profile_guid = profile_adapter_id(&physical).ok().map(|guid| format!("{guid:?}"));
    let manager = NetworkOperatorTetheringManager::CreateFromConnectionProfile(&physical)
        .context("CreateFromConnectionProfile(restore physical) failed")?;
    stop_tethering(&manager, reason)?;
    start_tethering(&manager, reason)?;
    LEASE_ACTIVE.store(false, Ordering::Release);
    RESTORE_PENDING.store(false, Ordering::Release);
    diagnostics::info(
        "windows-hotspot-winrt",
        "physical-restore-completed",
        json!({
            "reason": reason,
            "profile_name": profile_name,
            "profile_guid": profile_guid,
            "strategy": "stop-then-start-from-best-physical-profile",
        }),
    );
    Ok(true)
}

pub async fn suspend_for_tun_teardown(reason: &'static str) -> Result<bool> {
    TEARDOWN_SUPPRESSED.store(true, Ordering::Release);
    if !LEASE_ACTIVE.load(Ordering::Acquire) {
        return Ok(false);
    }
    tokio::task::spawn_blocking(move || -> Result<bool> {
        let _guard = MUTATION_LOCK
            .lock()
            .map_err(|_| anyhow!("Windows WinRT hotspot mutation lock was poisoned"))?;
        let _apartment = WinRtApartment::init()?;
        let manager = if let Some(tun_guid) = mihomo_tun_guid()?
            && let Some(profile) = find_tun_profile(tun_guid)?
        {
            NetworkOperatorTetheringManager::CreateFromConnectionProfile(&profile)
                .context("CreateFromConnectionProfile(Mihomo teardown) failed")?
        } else {
            let physical = best_physical_profile(None)?
                .ok_or_else(|| anyhow!("no ConnectionProfile is available to stop hotspot before TUN teardown"))?;
            NetworkOperatorTetheringManager::CreateFromConnectionProfile(&physical)
                .context("CreateFromConnectionProfile(teardown fallback) failed")?
        };
        stop_tethering(&manager, reason)?;
        LEASE_ACTIVE.store(false, Ordering::Release);
        RESTORE_PENDING.store(true, Ordering::Release);
        diagnostics::info(
            "windows-hotspot-winrt",
            "teardown-suspended",
            json!({
                "reason": reason,
                "restore_pending": true,
                "action": "keep-hotspot-off-until-tun-is-gone",
            }),
        );
        Ok(true)
    })
    .await
    .context("Windows WinRT hotspot teardown task failed")?
}

pub async fn restore_after_tun_teardown(reason: &'static str) -> Result<bool> {
    if !RESTORE_PENDING.load(Ordering::Acquire) {
        return Ok(false);
    }
    tokio::task::spawn_blocking(move || restore_to_physical(reason))
        .await
        .context("Windows WinRT hotspot physical restore task failed")?
}

async fn monitor_loop() {
    diagnostics::info(
        "windows-hotspot-winrt",
        "monitor-started",
        json!({
            "poll_interval_ms": LOOP_INTERVAL.as_millis(),
            "mutation_api": "NetworkOperatorTetheringManager",
            "profile_identity": "ip-helper-tun-guid-to-connection-profile",
            "start_sequence": "StopTetheringAsync-then-StartTetheringAsync",
            "async_wait": "IAsyncOperation::join-on-single-spawn-blocking-thread",
            "legacy_hnetcfg_mutation": false,
            "two_phase_shutdown_restore": true,
        }),
    );
    let mut interval = tokio::time::interval(LOOP_INTERVAL);
    let mut last_outcome = String::new();
    let mut last_error = String::new();
    loop {
        interval.tick().await;
        if TEARDOWN_SUPPRESSED.load(Ordering::Acquire) {
            continue;
        }
        let tun_enabled = Config::verge().await.latest_arc().enable_tun_mode.unwrap_or(false);
        let outcome = if tun_enabled {
            tokio::task::spawn_blocking(reconcile_tun_hotspot).await
        } else if LEASE_ACTIVE.load(Ordering::Acquire) || RESTORE_PENDING.load(Ordering::Acquire) {
            tokio::task::spawn_blocking(|| restore_to_physical("tun-disabled"))
                .await
                .map(|result| result.map(|restored| if restored { "physical-restored" } else { "no-restore" }))
        } else {
            continue;
        };

        match outcome {
            Ok(Ok(outcome)) => {
                last_error.clear();
                if outcome != last_outcome {
                    diagnostics::info(
                        "windows-hotspot-winrt",
                        "reconcile-succeeded",
                        json!({"outcome": outcome}),
                    );
                    last_outcome = outcome.to_owned();
                }
            }
            Ok(Err(error)) => {
                let message = error.to_string();
                if message != last_error {
                    diagnostics::error(
                        "windows-hotspot-winrt",
                        "reconcile-failed",
                        json!({
                            "error": message,
                            "lease_active": LEASE_ACTIVE.load(Ordering::Acquire),
                            "restore_pending": RESTORE_PENDING.load(Ordering::Acquire),
                            "action": "fail-closed-and-retry-on-next-stable-cycle",
                        }),
                    );
                    last_error = message;
                }
            }
            Err(error) => {
                let message = error.to_string();
                if message != last_error {
                    diagnostics::error(
                        "windows-hotspot-winrt",
                        "reconcile-task-failed",
                        json!({"error": message}),
                    );
                    last_error = message;
                }
            }
        }
    }
}

pub fn ensure_monitor_running() {
    if MONITOR_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    AsyncHandler::spawn(|| async {
        monitor_loop().await;
    });
}

#[cfg(test)]
mod tests {
    use super::connectivity_score;
    use windows::Networking::Connectivity::NetworkConnectivityLevel;

    #[test]
    fn physical_profile_score_prefers_real_internet_access() {
        assert!(
            connectivity_score(NetworkConnectivityLevel::InternetAccess)
                > connectivity_score(NetworkConnectivityLevel::ConstrainedInternetAccess)
        );
        assert!(
            connectivity_score(NetworkConnectivityLevel::ConstrainedInternetAccess)
                > connectivity_score(NetworkConnectivityLevel::LocalAccess)
        );
    }
}
