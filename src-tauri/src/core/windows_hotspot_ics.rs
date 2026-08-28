use std::{
    ffi::c_void,
    fs,
    path::{Path, PathBuf},
    ptr::null_mut,
    slice,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context as _, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::json;
use windows::{
    Networking::{
        Connectivity::{ConnectionProfile, NetworkConnectivityLevel, NetworkInformation},
        NetworkOperators::{
            NetworkOperatorTetheringManager, NetworkOperatorTetheringOperationResult, TetheringCapability,
            TetheringOperationStatus, TetheringOperationalState,
        },
    },
    Win32::{
        NetworkManagement::{
            IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_ROW2, MIB_IF_TABLE2},
            Ndis::IfOperStatusUp,
        },
        System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize},
    },
    core::GUID,
};

use crate::{config::Config, core::diagnostics, process::AsyncHandler, utils::dirs};

const LOOP_INTERVAL: Duration = Duration::from_secs(2);
const STABLE_SAMPLES: u8 = 3;
const SNAPSHOT_FILE: &str = "windows-hotspot-winrt-lease-v22.json";

static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);
static RESTORE_REQUESTED: AtomicBool = AtomicBool::new(false);
static MUTATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq)]
struct InterfaceIdentity {
    guid: GUID,
    alias: String,
    description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SavedTetheringState {
    version: u8,
    created_unix_ms: u128,
    tun_guid: String,
    original_public_guid: String,
    original_public_profile: String,
    hotspot_was_on: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ProfileLog {
    guid: String,
    name: String,
    connectivity: String,
    tethering_capability: String,
}

struct ComApartment;

impl ComApartment {
    fn init() -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .context("CoInitializeEx(COINIT_MULTITHREADED) failed")?;
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn utf16z(value: &[u16]) -> String {
    let len = value.iter().position(|item| *item == 0).unwrap_or(value.len());
    String::from_utf16_lossy(&value[..len])
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

fn target_tun() -> Result<Option<InterfaceIdentity>> {
    let mut candidates = load_interfaces()?
        .iter()
        .filter(|row| is_mihomo_tun(row))
        .map(|row| InterfaceIdentity {
            guid: row.InterfaceGuid,
            alias: utf16z(&row.Alias),
            description: utf16z(&row.Description),
        })
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return Ok(None);
    }
    if candidates.len() != 1 {
        diagnostics::warn(
            "windows-hotspot-winrt",
            "target-identification-ambiguous",
            json!({
                "tun_candidates": candidates.iter().map(|item| json!({
                    "guid": guid_string(item.guid),
                    "alias": item.alias,
                    "description": item.description,
                })).collect::<Vec<_>>(),
                "action": "fail-closed-no-tethering-mutation",
            }),
        );
        return Ok(None);
    }
    Ok(Some(candidates.remove(0)))
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

fn save_snapshot(path: &Path, snapshot: &SavedTetheringState) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    let _ = fs::remove_file(&temporary);
    fs::write(&temporary, serde_json::to_vec_pretty(snapshot)?)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn load_snapshot(path: &Path) -> Result<Option<SavedTetheringState>> {
    match fs::read(path) {
        Ok(bytes) => {
            let snapshot: SavedTetheringState = serde_json::from_slice(&bytes)?;
            if snapshot.version != 3 {
                bail!(
                    "unsupported Windows hotspot WinRT snapshot version {}",
                    snapshot.version
                );
            }
            Ok(Some(snapshot))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn remove_snapshot(path: &Path) -> Result<()> {
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
    profile
        .ProfileName()
        .map(|value| value.to_string())
        .unwrap_or_else(|_| "<unknown>".to_owned())
}

fn profiles() -> Result<Vec<ConnectionProfile>> {
    let view = NetworkInformation::GetConnectionProfiles().context("GetConnectionProfiles failed")?;
    let size = view.Size()?;
    let mut result = Vec::with_capacity(size as usize);
    for index in 0..size {
        result.push(view.GetAt(index)?);
    }
    Ok(result)
}

fn find_profile_by_guid(items: &[ConnectionProfile], guid: GUID) -> Result<Option<ConnectionProfile>> {
    let mut matches = Vec::new();
    for profile in items {
        if profile_guid(profile)? == guid {
            matches.push(profile.clone());
        }
    }
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.pop()),
        count => bail!("adapter GUID {guid:?} mapped to {count} ConnectionProfiles"),
    }
}

fn find_profile_by_saved_guid(items: &[ConnectionProfile], guid: &str) -> Result<Option<ConnectionProfile>> {
    for profile in items {
        if same_guid(guid, profile_guid(profile)?) {
            return Ok(Some(profile.clone()));
        }
    }
    Ok(None)
}

fn profile_log(profile: &ConnectionProfile) -> Result<ProfileLog> {
    let capability = NetworkOperatorTetheringManager::GetTetheringCapabilityFromConnectionProfile(profile)
        .map(|value| format!("{value:?}"))
        .unwrap_or_else(|error| format!("error:{error}"));
    Ok(ProfileLog {
        guid: guid_string(profile_guid(profile)?),
        name: profile_name(profile),
        connectivity: format!("{:?}", profile.GetNetworkConnectivityLevel()?),
        tethering_capability: capability,
    })
}

fn find_original_public_profile(items: &[ConnectionProfile], tun_guid: GUID) -> Result<ConnectionProfile> {
    if let Ok(profile) = NetworkInformation::GetInternetConnectionProfile()
        && profile_guid(&profile)? != tun_guid
        && profile.GetNetworkConnectivityLevel()? == NetworkConnectivityLevel::InternetAccess
    {
        return Ok(profile);
    }

    let mut candidates = Vec::new();
    for profile in items {
        let guid = profile_guid(profile)?;
        if guid == tun_guid {
            continue;
        }
        if profile.GetNetworkConnectivityLevel()? == NetworkConnectivityLevel::InternetAccess {
            candidates.push(profile.clone());
        }
    }

    if candidates.len() != 1 {
        diagnostics::warn(
            "windows-hotspot-winrt",
            "original-public-profile-ambiguous",
            json!({
                "tun_guid": guid_string(tun_guid),
                "candidates": candidates.iter().filter_map(|profile| profile_log(profile).ok()).collect::<Vec<_>>(),
                "action": "fail-closed-preserve-current-hotspot",
            }),
        );
        bail!(
            "expected exactly one non-TUN InternetAccess ConnectionProfile, found {}",
            candidates.len()
        );
    }
    Ok(candidates.remove(0))
}

fn manager_for(profile: &ConnectionProfile) -> Result<NetworkOperatorTetheringManager> {
    NetworkOperatorTetheringManager::CreateFromConnectionProfile(profile)
        .context("CreateFromConnectionProfile failed")
}

fn require_capability(profile: &ConnectionProfile) -> Result<()> {
    let capability = NetworkOperatorTetheringManager::GetTetheringCapabilityFromConnectionProfile(profile)
        .context("GetTetheringCapabilityFromConnectionProfile failed")?;
    if capability != TetheringCapability::Enabled {
        bail!(
            "ConnectionProfile {} is not tethering-capable: {capability:?}",
            profile_name(profile)
        );
    }
    Ok(())
}

fn operation_details(result: &NetworkOperatorTetheringOperationResult) -> (TetheringOperationStatus, String) {
    let status = result.Status().unwrap_or(TetheringOperationStatus::Unknown);
    let message = result
        .AdditionalErrorMessage()
        .map(|value| value.to_string())
        .unwrap_or_else(|error| format!("<unavailable: {error}>"));
    (status, message)
}

fn stop_tethering(manager: &NetworkOperatorTetheringManager, phase: &'static str) -> Result<()> {
    if manager.TetheringOperationalState()? == TetheringOperationalState::Off {
        return Ok(());
    }
    let result = manager
        .StopTetheringAsync()
        .context("StopTetheringAsync creation failed")?
        .join()
        .context("StopTetheringAsync execution failed")?;
    let (status, additional_error) = operation_details(&result);
    diagnostics::info(
        "windows-hotspot-winrt",
        "tethering-stop-result",
        json!({
            "phase": phase,
            "status": format!("{status:?}"),
            "additional_error": additional_error,
        }),
    );
    if status != TetheringOperationStatus::Success {
        bail!("StopTetheringAsync returned {status:?}: {additional_error}");
    }
    if manager.TetheringOperationalState()? != TetheringOperationalState::Off {
        bail!("tethering did not reach Off after StopTetheringAsync");
    }
    Ok(())
}

fn start_tethering(manager: &NetworkOperatorTetheringManager, phase: &'static str) -> Result<()> {
    let result = manager
        .StartTetheringAsync()
        .context("StartTetheringAsync creation failed")?
        .join()
        .context("StartTetheringAsync execution failed")?;
    let (status, additional_error) = operation_details(&result);
    diagnostics::info(
        "windows-hotspot-winrt",
        "tethering-start-result",
        json!({
            "phase": phase,
            "status": format!("{status:?}"),
            "additional_error": additional_error,
        }),
    );
    if status != TetheringOperationStatus::Success && status != TetheringOperationStatus::AlreadyOn {
        bail!("StartTetheringAsync returned {status:?}: {additional_error}");
    }
    if manager.TetheringOperationalState()? != TetheringOperationalState::On {
        bail!("tethering did not reach On after StartTetheringAsync");
    }
    Ok(())
}

fn restore_snapshot_unlocked(path: &Path, snapshot: &SavedTetheringState) -> Result<()> {
    let _apartment = ComApartment::init()?;
    let items = profiles()?;
    let original = find_profile_by_saved_guid(&items, &snapshot.original_public_guid)?
        .ok_or_else(|| anyhow!("original hotspot public ConnectionProfile is no longer available"))?;

    require_capability(&original)?;
    let original_manager = manager_for(&original)?;

    // Tethering state is system-global. Stop the current session first even if the
    // original source profile is not the profile currently backing the hotspot.
    stop_tethering(&original_manager, "restore-stop-current")?;
    if snapshot.hotspot_was_on {
        start_tethering(&original_manager, "restore-original-public")?;
    }

    remove_snapshot(path)?;
    diagnostics::info(
        "windows-hotspot-winrt",
        "lease-restored",
        json!({
            "original_public_guid": snapshot.original_public_guid,
            "original_public_profile": snapshot.original_public_profile,
            "hotspot_was_on": snapshot.hotspot_was_on,
            "snapshot_removed": true,
            "strategy": "winrt-create-from-connection-profile",
        }),
    );
    Ok(())
}

fn apply_tun_unlocked(path: &Path, tun: &InterfaceIdentity) -> Result<&'static str> {
    let _apartment = ComApartment::init()?;
    let items = profiles()?;
    let tun_profile = find_profile_by_guid(&items, tun.guid)?
        .ok_or_else(|| anyhow!("Mihomo TUN has no matching WinRT ConnectionProfile"))?;
    require_capability(&tun_profile)?;

    let tun_manager = manager_for(&tun_profile)?;
    let state = tun_manager.TetheringOperationalState()?;
    if state == TetheringOperationalState::Off {
        return Ok("hotspot-off-no-action");
    }
    if state == TetheringOperationalState::InTransition {
        return Ok("hotspot-transition-no-action");
    }

    let original = find_original_public_profile(&items, tun.guid)?;
    let original_guid = profile_guid(&original)?;
    if original_guid == tun.guid {
        bail!("refusing to snapshot Mihomo TUN as original hotspot public profile");
    }

    let snapshot = SavedTetheringState {
        version: 3,
        created_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        tun_guid: guid_string(tun.guid),
        original_public_guid: guid_string(original_guid),
        original_public_profile: profile_name(&original),
        hotspot_was_on: true,
    };
    save_snapshot(path, &snapshot)?;

    diagnostics::info(
        "windows-hotspot-winrt",
        "apply-before",
        json!({
            "tun": profile_log(&tun_profile).ok(),
            "original_public": profile_log(&original).ok(),
            "operational_state": format!("{state:?}"),
            "snapshot_file_present": true,
            "mutation_api": "NetworkOperatorTetheringManager",
        }),
    );

    let apply_result = (|| -> Result<()> {
        // Creating a manager while Mobile Hotspot is already On does not prove that
        // Windows rebound the existing session. Force a clean Stop -> Start so the
        // new CreateFromConnectionProfile(Mihomo) public source owns the session.
        stop_tethering(&tun_manager, "rebind-stop-existing")?;
        start_tethering(&tun_manager, "rebind-start-mihomo")?;
        Ok(())
    })();

    if let Err(error) = apply_result {
        diagnostics::error(
            "windows-hotspot-winrt",
            "apply-failed",
            json!({
                "error": error.to_string(),
                "action": "restore-original-hotspot-immediately",
                "snapshot_preserved_until_restore_succeeds": true,
            }),
        );
        restore_snapshot_unlocked(path, &snapshot).context("WinRT apply failed and rollback also failed")?;
        return Err(error);
    }

    diagnostics::info(
        "windows-hotspot-winrt",
        "lease-applied",
        json!({
            "tun_guid": guid_string(tun.guid),
            "tun_alias": tun.alias,
            "tun_description": tun.description,
            "tun_profile": profile_name(&tun_profile),
            "original_public_guid": guid_string(original_guid),
            "original_public_profile": profile_name(&original),
            "desired_topology": "mihomo-connection-profile=public,wifi=private",
            "strategy": "winrt-stop-then-createfromconnectionprofile-start",
            "powershell": false,
            "hnetcfg_mutation": false,
        }),
    );
    Ok("lease-applied")
}

fn mutation_guard() -> Result<std::sync::MutexGuard<'static, ()>> {
    MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow!("Windows hotspot WinRT mutation lock was poisoned"))
}

fn active_snapshot_state(snapshot: &SavedTetheringState) -> Result<TetheringOperationalState> {
    let _apartment = ComApartment::init()?;
    let items = profiles()?;
    let Some(tun_profile) = find_profile_by_saved_guid(&items, &snapshot.tun_guid)? else {
        return Ok(TetheringOperationalState::Off);
    };
    Ok(manager_for(&tun_profile)?.TetheringOperationalState()?)
}

fn reconcile_once(tun_enabled: bool, path: &Path) -> Result<&'static str> {
    let _guard = mutation_guard()?;
    let saved = load_snapshot(path)?;

    if let Some(snapshot) = saved {
        if !tun_enabled || RESTORE_REQUESTED.load(Ordering::Acquire) {
            restore_snapshot_unlocked(path, &snapshot)?;
            return Ok("lease-restored");
        }

        let state = active_snapshot_state(&snapshot)?;
        if state == TetheringOperationalState::Off {
            // Respect a user turning Mobile Hotspot off while TUN is still enabled.
            // Clearing the snapshot prevents the monitor from immediately turning it
            // back on. If the user later turns Hotspot on again, the next stable
            // window will establish a fresh Mihomo-backed session.
            remove_snapshot(path)?;
            diagnostics::info(
                "windows-hotspot-winrt",
                "lease-cleared-user-hotspot-off",
                json!({
                    "hotspot_restarted": false,
                    "user_intent_preserved": true,
                }),
            );
            return Ok("lease-cleared-user-hotspot-off");
        }
        return Ok("lease-already-active");
    }

    if !tun_enabled || RESTORE_REQUESTED.load(Ordering::Acquire) {
        return Ok("no-action");
    }

    let Some(tun) = target_tun()? else {
        return Ok("no-action");
    };
    apply_tun_unlocked(path, &tun)
}

pub async fn restore_now(reason: &'static str) -> Result<bool> {
    RESTORE_REQUESTED.store(true, Ordering::Release);
    let path = snapshot_path()?;
    let path_for_task = path.clone();
    let restored = tokio::task::spawn_blocking(move || -> Result<bool> {
        let _guard = mutation_guard()?;
        let Some(snapshot) = load_snapshot(&path_for_task)? else {
            return Ok(false);
        };
        restore_snapshot_unlocked(&path_for_task, &snapshot)?;
        Ok(true)
    })
    .await
    .context("Windows WinRT hotspot explicit restore task failed")??;

    diagnostics::info(
        "windows-hotspot-winrt",
        "explicit-restore-completed",
        json!({
            "reason": reason,
            "restored": restored,
            "snapshot_file_present": path.exists(),
            "reapply_suppressed": true,
        }),
    );
    Ok(restored)
}

async fn monitor_loop() {
    diagnostics::info(
        "windows-hotspot-winrt",
        "monitor-started",
        json!({
            "poll_interval_ms": LOOP_INTERVAL.as_millis(),
            "stable_samples": STABLE_SAMPLES,
            "target_identification": "ip-helper-tun-guid-to-winrt-connection-profile",
            "mutation_api": "NetworkOperatorTetheringManager",
            "public_source_factory": "CreateFromConnectionProfile",
            "operation_wait": "IAsyncOperation::join",
            "powershell": false,
            "hnetcfg_mutation": false,
            "persistent_rollback": true,
            "shutdown_restore_gate": true,
            "user_hotspot_off_policy": "respect-and-clear-lease",
            "desired_topology": "mihomo-connection-profile=public,wifi=private",
        }),
    );

    let path = match snapshot_path() {
        Ok(path) => path,
        Err(error) => {
            diagnostics::error(
                "windows-hotspot-winrt",
                "snapshot-path-failed",
                json!({"error": error.to_string()}),
            );
            return;
        }
    };

    let mut stable_signature: Option<String> = None;
    let mut stable_count = 0u8;
    let mut last_outcome = String::new();
    let mut last_error = String::new();
    let mut interval = tokio::time::interval(LOOP_INTERVAL);

    loop {
        interval.tick().await;
        let tun_enabled = Config::verge().await.latest_arc().enable_tun_mode.unwrap_or(false);
        let restore_requested = RESTORE_REQUESTED.load(Ordering::Acquire);
        let snapshot_present = path.exists();

        let signature = if !tun_enabled || restore_requested {
            format!("inactive:{snapshot_present}")
        } else {
            let discovery = tokio::task::spawn_blocking(target_tun).await;
            match discovery {
                Ok(Ok(Some(tun))) => format!("tun:{}:{snapshot_present}", normalize_guid(&guid_string(tun.guid))),
                Ok(Ok(None)) => format!("tun:none:{snapshot_present}"),
                Ok(Err(error)) => {
                    let message = format!("discovery: {error}");
                    if message != last_error {
                        diagnostics::warn(
                            "windows-hotspot-winrt",
                            "target-discovery-failed",
                            json!({"error": error.to_string(), "error_kind": "discovery"}),
                        );
                        last_error = message;
                    }
                    continue;
                }
                Err(error) => {
                    let message = format!("join: {error}");
                    if message != last_error {
                        diagnostics::warn(
                            "windows-hotspot-winrt",
                            "target-discovery-failed",
                            json!({"error": error.to_string(), "error_kind": "join"}),
                        );
                        last_error = message;
                    }
                    continue;
                }
            }
        };

        if stable_signature.as_deref() == Some(&signature) {
            stable_count = stable_count.saturating_add(1);
        } else {
            stable_signature = Some(signature.clone());
            stable_count = 1;
        }
        if stable_count < STABLE_SAMPLES {
            continue;
        }

        let path_for_task = path.clone();
        let outcome = tokio::task::spawn_blocking(move || reconcile_once(tun_enabled, &path_for_task)).await;
        match outcome {
            Ok(Ok(outcome)) => {
                last_error.clear();
                if outcome != last_outcome {
                    diagnostics::info(
                        "windows-hotspot-winrt",
                        "reconcile-succeeded",
                        json!({
                            "outcome": outcome,
                            "stable_signature": signature,
                            "stable_samples": stable_count,
                        }),
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
                            "stable_signature": signature,
                            "snapshot_file_present": path.exists(),
                            "action": "fail-closed-or-rollback",
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
    use super::{SavedTetheringState, normalize_guid, same_guid};
    use windows::core::GUID;

    #[test]
    fn windows_hotspot_guid_normalization_ignores_braces_case_and_space() {
        assert_eq!(
            normalize_guid(" {ABCDEFAB-1234-5678-90AB-ABCDEFABCDEF} "),
            "abcdefab-1234-5678-90ab-abcdefabcdef"
        );
    }

    #[test]
    fn windows_hotspot_saved_guid_matches_native_guid() {
        let guid = GUID::from_u128(0x11111111_1111_1111_1111_111111111111);
        assert!(same_guid("{11111111-1111-1111-1111-111111111111}", guid));
    }

    #[test]
    fn windows_hotspot_snapshot_v22_preserves_original_public_and_user_state() {
        let snapshot = SavedTetheringState {
            version: 3,
            created_unix_ms: 1,
            tun_guid: "{11111111-1111-1111-1111-111111111111}".into(),
            original_public_guid: "{22222222-2222-2222-2222-222222222222}".into(),
            original_public_profile: "WLAN".into(),
            hotspot_was_on: true,
        };
        assert_eq!(snapshot.version, 3);
        assert!(snapshot.hotspot_was_on);
        assert_ne!(snapshot.tun_guid, snapshot.original_public_guid);
    }
}
