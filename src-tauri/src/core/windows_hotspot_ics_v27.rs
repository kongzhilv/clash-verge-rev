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
    Win32::{
        NetworkManagement::{
            IpHelper::{
                FreeMibTable, GetIfTable2, GetUnicastIpAddressTable, MIB_IF_ROW2, MIB_IF_TABLE2,
                MIB_UNICASTIPADDRESS_ROW, MIB_UNICASTIPADDRESS_TABLE,
            },
            Ndis::IfOperStatusUp,
            WindowsFirewall::{
                ICSSHARINGTYPE_PRIVATE, ICSSHARINGTYPE_PUBLIC, INetConnection, INetConnectionManager,
                INetSharingConfiguration, INetSharingManager, NCME_DEFAULT, NetSharingManager,
            },
        },
        Networking::WinSock::{AF_INET, IpDadStatePreferred, SOCKADDR_INET},
        System::Com::{CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize},
    },
    core::GUID,
};

use crate::{config::Config, core::diagnostics, process::AsyncHandler, utils::dirs};

const LOOP_INTERVAL: Duration = Duration::from_secs(2);
const STABLE_SAMPLES: u8 = 3;
const SNAPSHOT_FILE: &str = "windows-hotspot-ics-lease-v27.json";
const CONNECTION_MANAGER: GUID = GUID::from_u128(0xba126ad1_2166_11d1_b1d0_00805fc1270e);

static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);
static RESTORE_REQUESTED: AtomicBool = AtomicBool::new(false);
static MUTATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq)]
struct InterfaceIdentity {
    guid: GUID,
    alias: String,
    description: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TargetPair {
    tun: InterfaceIdentity,
    hotspot: InterfaceIdentity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SharingRole {
    Public,
    Private,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SavedRole {
    guid: String,
    role: SharingRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SavedSharingState {
    version: u8,
    created_unix_ms: u128,
    tun_guid: String,
    hotspot_guid: String,
    originally_shared: Vec<SavedRole>,
}

struct ComApartment;

impl ComApartment {
    fn init() -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .context("CoInitializeEx(COINIT_APARTMENTTHREADED) failed")?;
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

fn ipv4_from_sockaddr(value: &SOCKADDR_INET) -> Option<std::net::Ipv4Addr> {
    if unsafe { value.si_family } != AF_INET {
        return None;
    }
    let raw = unsafe { value.Ipv4.sin_addr.S_un.S_addr };
    Some(std::net::Ipv4Addr::from(raw.to_ne_bytes()))
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

fn load_addresses() -> Result<Vec<MIB_UNICASTIPADDRESS_ROW>> {
    let mut table: *mut MIB_UNICASTIPADDRESS_TABLE = null_mut();
    let status = unsafe { GetUnicastIpAddressTable(AF_INET, &mut table) };
    if status.0 != 0 || table.is_null() {
        bail!("GetUnicastIpAddressTable failed with Windows error {}", status.0);
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

fn is_mobile_hotspot_adapter(row: &MIB_IF_ROW2) -> bool {
    if row.OperStatus != IfOperStatusUp {
        return false;
    }
    let identity = interface_identity(row);
    !is_filter_component(&identity)
        && [
            "wi-fi direct virtual adapter",
            "wifi direct virtual adapter",
            "microsoft hosted network",
            "hosted network virtual",
            "mobile hotspot",
        ]
        .iter()
        .any(|marker| identity.contains(marker))
}

fn has_private_ipv4(interface_index: u32, addresses: &[MIB_UNICASTIPADDRESS_ROW]) -> bool {
    addresses.iter().any(|row| {
        row.InterfaceIndex == interface_index
            && row.DadState == IpDadStatePreferred
            && ipv4_from_sockaddr(&row.Address).is_some_and(|address| address.is_private())
            && (8..=30).contains(&row.OnLinkPrefixLength)
    })
}

fn target_pair() -> Result<Option<TargetPair>> {
    let interfaces = load_interfaces()?;
    let addresses = load_addresses()?;

    let tun_candidates = interfaces
        .iter()
        .filter(|row| is_mihomo_tun(row))
        .map(|row| InterfaceIdentity {
            guid: row.InterfaceGuid,
            alias: utf16z(&row.Alias),
            description: utf16z(&row.Description),
        })
        .collect::<Vec<_>>();
    let hotspot_candidates = interfaces
        .iter()
        .filter(|row| is_mobile_hotspot_adapter(row) && has_private_ipv4(row.InterfaceIndex, &addresses))
        .map(|row| InterfaceIdentity {
            guid: row.InterfaceGuid,
            alias: utf16z(&row.Alias),
            description: utf16z(&row.Description),
        })
        .collect::<Vec<_>>();

    if tun_candidates.is_empty() || hotspot_candidates.is_empty() {
        return Ok(None);
    }
    if tun_candidates.len() != 1 || hotspot_candidates.len() != 1 {
        diagnostics::warn(
            "windows-hotspot-ics",
            "target-identification-ambiguous",
            json!({
                "tun_candidates": tun_candidates.iter().map(|item| json!({
                    "guid": guid_string(item.guid), "alias": item.alias, "description": item.description,
                })).collect::<Vec<_>>(),
                "hotspot_candidates": hotspot_candidates.iter().map(|item| json!({
                    "guid": guid_string(item.guid), "alias": item.alias, "description": item.description,
                })).collect::<Vec<_>>(),
                "action": "fail-closed-no-ics-mutation",
            }),
        );
        return Ok(None);
    }

    Ok(Some(TargetPair {
        tun: tun_candidates.into_iter().next().expect("checked non-empty"),
        hotspot: hotspot_candidates.into_iter().next().expect("checked non-empty"),
    }))
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

fn role_of_guid(roles: &[SavedRole], guid: GUID) -> Option<SharingRole> {
    roles
        .iter()
        .find(|item| same_guid(&item.guid, guid))
        .map(|item| item.role)
}

fn role_of_saved_guid(roles: &[SavedRole], guid: &str) -> Option<SharingRole> {
    roles
        .iter()
        .find(|item| normalize_guid(&item.guid) == normalize_guid(guid))
        .map(|item| item.role)
}

fn snapshot_path() -> Result<PathBuf> {
    Ok(dirs::app_home_dir()?.join(SNAPSHOT_FILE))
}

fn save_snapshot(path: &Path, snapshot: &SavedSharingState) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    let _ = fs::remove_file(&temporary);
    fs::write(&temporary, serde_json::to_vec_pretty(snapshot)?)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn load_snapshot(path: &Path) -> Result<Option<SavedSharingState>> {
    match fs::read(path) {
        Ok(bytes) => {
            let snapshot: SavedSharingState = serde_json::from_slice(&bytes)?;
            if snapshot.version != 3 {
                bail!("unsupported Windows hotspot ICS snapshot version {}", snapshot.version);
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

fn create_managers() -> Result<(ComApartment, INetSharingManager, INetConnectionManager)> {
    let apartment = ComApartment::init()?;
    let sharing_manager: INetSharingManager =
        unsafe { CoCreateInstance(&NetSharingManager, None, CLSCTX_ALL) }.context("create NetSharingManager failed")?;
    let connection_manager: INetConnectionManager = unsafe { CoCreateInstance(&CONNECTION_MANAGER, None, CLSCTX_ALL) }
        .context("create Network Connection Manager failed")?;
    Ok((apartment, sharing_manager, connection_manager))
}

fn enumerate_connections(connection_manager: &INetConnectionManager) -> Result<Vec<INetConnection>> {
    let enumerator = unsafe { connection_manager.EnumConnections(NCME_DEFAULT) }
        .context("INetConnectionManager::EnumConnections failed")?;
    let mut result = Vec::new();
    loop {
        let mut slot: [Option<INetConnection>; 1] = [None];
        let mut fetched = 0u32;
        unsafe { enumerator.Next(&mut slot, &mut fetched) }.context("IEnumNetConnection::Next failed")?;
        if fetched == 0 {
            break;
        }
        if let Some(connection) = slot[0].take() {
            result.push(connection);
        }
    }
    Ok(result)
}

fn sharing_configuration(manager: &INetSharingManager, connection: &INetConnection) -> Result<INetSharingConfiguration> {
    unsafe { manager.get_INetSharingConfigurationForINetConnection(connection) }
        .context("get_INetSharingConfigurationForINetConnection failed")
}

fn connection_guid(manager: &INetSharingManager, connection: &INetConnection) -> Result<String> {
    let props = unsafe { manager.get_NetConnectionProps(connection) }.context("get_NetConnectionProps failed")?;
    Ok(unsafe { props.Guid() }.context("INetConnectionProps::Guid failed")?.to_string())
}

fn connection_role(manager: &INetSharingManager, connection: &INetConnection) -> Result<Option<SharingRole>> {
    let config = sharing_configuration(manager, connection)?;
    let enabled = unsafe { config.SharingEnabled() }
        .context("INetSharingConfiguration::SharingEnabled failed")?
        .0 != 0;
    if !enabled {
        return Ok(None);
    }
    let role = unsafe { config.SharingConnectionType() }
        .context("INetSharingConfiguration::SharingConnectionType failed")?;
    Ok(if role == ICSSHARINGTYPE_PUBLIC {
        Some(SharingRole::Public)
    } else if role == ICSSHARINGTYPE_PRIVATE {
        Some(SharingRole::Private)
    } else {
        None
    })
}

fn current_shared_roles(manager: &INetSharingManager, connections: &[INetConnection]) -> Result<Vec<SavedRole>> {
    let mut roles = Vec::new();
    for connection in connections {
        if let Some(role) = connection_role(manager, connection)? {
            roles.push(SavedRole { guid: connection_guid(manager, connection)?, role });
        }
    }
    roles.sort_by(|left, right| left.guid.cmp(&right.guid));
    Ok(roles)
}

fn find_connection(
    manager: &INetSharingManager,
    connections: &[INetConnection],
    guid: &str,
) -> Result<Option<INetConnection>> {
    for connection in connections {
        if normalize_guid(&connection_guid(manager, connection)?) == normalize_guid(guid) {
            return Ok(Some(connection.clone()));
        }
    }
    Ok(None)
}

fn set_role(configuration: &INetSharingConfiguration, role: SharingRole) -> Result<()> {
    unsafe {
        match role {
            SharingRole::Public => configuration.EnableSharing(ICSSHARINGTYPE_PUBLIC),
            SharingRole::Private => configuration.EnableSharing(ICSSHARINGTYPE_PRIVATE),
        }
    }
    .context("INetSharingConfiguration::EnableSharing failed")
}

fn reconcile_role(
    manager: &INetSharingManager,
    connection: &INetConnection,
    desired: Option<SharingRole>,
) -> Result<bool> {
    let current = connection_role(manager, connection)?;
    if current == desired {
        return Ok(false);
    }
    let config = sharing_configuration(manager, connection)?;
    match desired {
        Some(role) => set_role(&config, role)?,
        None if current.is_some() => unsafe { config.DisableSharing() }.context("DisableSharing failed")?,
        None => return Ok(false),
    }
    Ok(true)
}

fn has_unrelated_private_role(original: &[SavedRole], pair: &TargetPair) -> bool {
    original.iter().any(|item| {
        item.role == SharingRole::Private
            && !same_guid(&item.guid, pair.tun.guid)
            && !same_guid(&item.guid, pair.hotspot.guid)
    })
}

fn lease_owned_original_roles(original: &[SavedRole], pair: &TargetPair) -> Vec<SavedRole> {
    original
        .iter()
        .filter(|item| {
            item.role == SharingRole::Public
                || same_guid(&item.guid, pair.tun.guid)
                || same_guid(&item.guid, pair.hotspot.guid)
        })
        .cloned()
        .collect()
}

fn lease_roles_are_desired(roles: &[SavedRole], pair: &TargetPair) -> bool {
    role_of_guid(roles, pair.tun.guid) == Some(SharingRole::Public)
        && role_of_guid(roles, pair.hotspot.guid) == Some(SharingRole::Private)
}

fn restore_snapshot_unlocked(path: &Path, snapshot: &SavedSharingState) -> Result<()> {
    let (_apartment, manager, connection_manager) = create_managers()?;
    let connections = enumerate_connections(&connection_manager)?;

    for saved in snapshot.originally_shared.iter().filter(|item| item.role == SharingRole::Public) {
        let connection = find_connection(&manager, &connections, &saved.guid)?
            .ok_or_else(|| anyhow!("cannot restore original PUBLIC ICS connection {}", saved.guid))?;
        reconcile_role(&manager, &connection, Some(SharingRole::Public))?;
    }
    for saved in snapshot.originally_shared.iter().filter(|item| item.role == SharingRole::Private) {
        if let Some(connection) = find_connection(&manager, &connections, &saved.guid)? {
            reconcile_role(&manager, &connection, Some(SharingRole::Private))?;
        }
    }
    for guid in [&snapshot.tun_guid, &snapshot.hotspot_guid] {
        if role_of_saved_guid(&snapshot.originally_shared, guid).is_none()
            && let Some(connection) = find_connection(&manager, &connections, guid)?
        {
            reconcile_role(&manager, &connection, None)?;
        }
    }

    let after = current_shared_roles(&manager, &connections)?;
    for saved in &snapshot.originally_shared {
        if find_connection(&manager, &connections, &saved.guid)?.is_some()
            && role_of_saved_guid(&after, &saved.guid) != Some(saved.role)
        {
            bail!("original ICS role was not restored for {}", saved.guid);
        }
    }
    remove_snapshot(path)?;
    diagnostics::info("windows-hotspot-ics", "lease-restored", json!({"version": 27}));
    Ok(())
}

fn apply_pair_unlocked(path: &Path, pair: &TargetPair) -> Result<()> {
    let (_apartment, manager, connection_manager) = create_managers()?;
    let connections = enumerate_connections(&connection_manager)?;
    let original = current_shared_roles(&manager, &connections)?;

    if has_unrelated_private_role(&original, pair) {
        bail!("refusing to replace an unrelated existing PRIVATE ICS connection");
    }

    let tun = find_connection(&manager, &connections, &guid_string(pair.tun.guid))?
        .ok_or_else(|| anyhow!("Mihomo TUN connection disappeared before ICS apply"))?;
    let hotspot = find_connection(&manager, &connections, &guid_string(pair.hotspot.guid))?
        .ok_or_else(|| anyhow!("Mobile Hotspot connection disappeared before ICS apply"))?;

    let snapshot = SavedSharingState {
        version: 3,
        created_unix_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        tun_guid: guid_string(pair.tun.guid),
        hotspot_guid: guid_string(pair.hotspot.guid),
        originally_shared: lease_owned_original_roles(&original, pair),
    };
    save_snapshot(path, &snapshot)?;

    let apply = (|| -> Result<()> {
        // Mobile Hotspot does not necessarily expose its Windows-owned PRIVATE role
        // through HNetCfg. Explicitly establish the private side first, then move
        // PUBLIC to the TUN. Microsoft documents that choosing a new PUBLIC
        // connection automatically disables the previous PUBLIC connection.
        reconcile_role(&manager, &hotspot, Some(SharingRole::Private))?;
        std::thread::sleep(Duration::from_millis(500));
        reconcile_role(&manager, &tun, Some(SharingRole::Public))?;
        std::thread::sleep(Duration::from_millis(250));

        let after = current_shared_roles(&manager, &connections)?;
        if !lease_roles_are_desired(&after, pair) {
            bail!("ICS role verification failed after Mobile Hotspot TUN lease apply");
        }
        Ok(())
    })();

    if let Err(error) = apply {
        diagnostics::error(
            "windows-hotspot-ics",
            "lease-apply-failed",
            json!({"error": format!("{error:#}"), "action": "rollback-immediately"}),
        );
        restore_snapshot_unlocked(path, &snapshot).context("apply failed and rollback also failed")?;
        return Err(error);
    }

    diagnostics::info(
        "windows-hotspot-ics",
        "lease-applied",
        json!({
            "version": 27,
            "tun_guid": guid_string(pair.tun.guid),
            "hotspot_guid": guid_string(pair.hotspot.guid),
            "tun_alias_observed": pair.tun.alias,
            "hotspot_alias_observed": pair.hotspot.alias,
            "strategy": "dynamic-guid-mobile-hotspot-private-to-mihomo-tun-public",
            "hardcoded_upstream_interface": false,
            "hardcoded_hotspot_subnet": false,
        }),
    );
    Ok(())
}

fn mutation_guard() -> Result<std::sync::MutexGuard<'static, ()>> {
    MUTATION_LOCK.lock().map_err(|_| anyhow!("Windows hotspot ICS mutation lock was poisoned"))
}

fn reconcile_once(tun_enabled: bool, path: &Path) -> Result<&'static str> {
    let _guard = mutation_guard()?;
    let saved = load_snapshot(path)?;
    let pair = if tun_enabled && !RESTORE_REQUESTED.load(Ordering::Acquire) {
        target_pair()?
    } else {
        None
    };

    match (saved, pair) {
        (Some(snapshot), Some(pair))
            if same_guid(&snapshot.tun_guid, pair.tun.guid) && same_guid(&snapshot.hotspot_guid, pair.hotspot.guid) =>
        {
            let (_apartment, manager, connection_manager) = create_managers()?;
            let connections = enumerate_connections(&connection_manager)?;
            let roles = current_shared_roles(&manager, &connections)?;
            if lease_roles_are_desired(&roles, &pair) {
                Ok("lease-already-active")
            } else {
                restore_snapshot_unlocked(path, &snapshot)?;
                Ok("lease-drift-restored")
            }
        }
        (Some(snapshot), _) => {
            restore_snapshot_unlocked(path, &snapshot)?;
            Ok("lease-restored")
        }
        (None, Some(pair)) => {
            apply_pair_unlocked(path, &pair)?;
            Ok("lease-applied")
        }
        (None, None) => Ok("no-action"),
    }
}

pub async fn restore_now(reason: &'static str) -> Result<bool> {
    RESTORE_REQUESTED.store(true, Ordering::Release);
    let path = snapshot_path()?;
    let path_for_task = path.clone();
    let restored = tokio::task::spawn_blocking(move || -> Result<bool> {
        let _guard = mutation_guard()?;
        let Some(snapshot) = load_snapshot(&path_for_task)? else { return Ok(false); };
        restore_snapshot_unlocked(&path_for_task, &snapshot)?;
        Ok(true)
    })
    .await
    .context("Windows ICS explicit restore task failed")??;
    diagnostics::info("windows-hotspot-ics", "explicit-restore-completed", json!({"reason": reason, "restored": restored}));
    Ok(restored)
}

async fn monitor_loop() {
    diagnostics::info(
        "windows-hotspot-ics",
        "monitor-started",
        json!({
            "version": 27,
            "poll_interval_ms": LOOP_INTERVAL.as_millis(),
            "stable_samples": STABLE_SAMPLES,
            "target_identification": "runtime-interface-guid+device-class+private-ip",
            "mutation_api": "native-hnetcfg-com",
            "desired_topology": "mihomo-tun=ics-public;active-mobile-hotspot=ics-private",
            "generic": true,
        }),
    );

    let path = match snapshot_path() {
        Ok(path) => path,
        Err(error) => {
            diagnostics::error("windows-hotspot-ics", "snapshot-path-failed", json!({"error": error.to_string()}));
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

        let signature = tokio::task::spawn_blocking(move || -> Result<Option<String>> {
            if !tun_enabled || restore_requested {
                return Ok(None);
            }
            Ok(target_pair()?.map(|pair| format!(
                "{}:{}",
                normalize_guid(&guid_string(pair.tun.guid)),
                normalize_guid(&guid_string(pair.hotspot.guid))
            )))
        })
        .await;

        let signature = match signature {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                let message = error.to_string();
                if message != last_error {
                    diagnostics::warn("windows-hotspot-ics", "target-discovery-failed", json!({"error": message}));
                    last_error = message;
                }
                continue;
            }
            Err(error) => {
                let message = error.to_string();
                if message != last_error {
                    diagnostics::warn("windows-hotspot-ics", "target-discovery-task-failed", json!({"error": message}));
                    last_error = message;
                }
                continue;
            }
        };

        let current_signature = signature.unwrap_or_else(|| "inactive".to_owned());
        if stable_signature.as_deref() == Some(&current_signature) {
            stable_count = stable_count.saturating_add(1);
        } else {
            stable_signature = Some(current_signature.clone());
            stable_count = 1;
        }
        if stable_count < STABLE_SAMPLES {
            continue;
        }

        let path_for_task = path.clone();
        match tokio::task::spawn_blocking(move || reconcile_once(tun_enabled, &path_for_task)).await {
            Ok(Ok(outcome)) => {
                last_error.clear();
                if outcome != last_outcome {
                    diagnostics::info(
                        "windows-hotspot-ics",
                        "reconcile-succeeded",
                        json!({"outcome": outcome, "stable_signature": current_signature}),
                    );
                    last_outcome = outcome.to_owned();
                }
            }
            Ok(Err(error)) => {
                let message = format!("{error:#}");
                if message != last_error {
                    diagnostics::error(
                        "windows-hotspot-ics",
                        "reconcile-failed",
                        json!({"error": message, "action": "fail-closed-or-rollback"}),
                    );
                    last_error = message;
                }
            }
            Err(error) => {
                let message = error.to_string();
                if message != last_error {
                    diagnostics::error("windows-hotspot-ics", "reconcile-task-failed", json!({"error": message}));
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
    AsyncHandler::spawn(|| async { monitor_loop().await; });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> TargetPair {
        TargetPair {
            tun: InterfaceIdentity {
                guid: GUID::from_u128(0x11111111_1111_1111_1111_111111111111),
                alias: "any-tun-name".into(),
                description: "Meta Tunnel".into(),
            },
            hotspot: InterfaceIdentity {
                guid: GUID::from_u128(0x22222222_2222_2222_2222_222222222222),
                alias: "localized-or-changing-alias".into(),
                description: "Microsoft Wi-Fi Direct Virtual Adapter #2".into(),
            },
        }
    }

    #[test]
    fn v27_lease_requires_tun_public_and_hotspot_private_by_guid() {
        let pair = pair();
        let desired = vec![
            SavedRole { guid: guid_string(pair.tun.guid), role: SharingRole::Public },
            SavedRole { guid: guid_string(pair.hotspot.guid), role: SharingRole::Private },
        ];
        assert!(lease_roles_are_desired(&desired, &pair));
    }

    #[test]
    fn v27_unrelated_private_ics_is_fail_closed() {
        let pair = pair();
        let roles = vec![SavedRole {
            guid: format!("{:?}", GUID::from_u128(0x33333333_3333_3333_3333_333333333333)),
            role: SharingRole::Private,
        }];
        assert!(has_unrelated_private_role(&roles, &pair));
    }

    #[test]
    fn v27_snapshot_scope_keeps_original_public_and_targets_only() {
        let pair = pair();
        let roles = vec![
            SavedRole { guid: format!("{:?}", GUID::from_u128(0x33333333_3333_3333_3333_333333333333)), role: SharingRole::Public },
            SavedRole { guid: guid_string(pair.hotspot.guid), role: SharingRole::Private },
            SavedRole { guid: format!("{:?}", GUID::from_u128(0x44444444_4444_4444_4444_444444444444)), role: SharingRole::Private },
        ];
        let retained = lease_owned_original_roles(&roles, &pair);
        assert_eq!(retained.len(), 2);
        assert!(retained.iter().any(|item| item.role == SharingRole::Public));
        assert!(retained.iter().any(|item| same_guid(&item.guid, pair.hotspot.guid)));
    }

    #[test]
    fn v27_guid_matching_is_alias_and_ifindex_independent() {
        let guid = GUID::from_u128(0xabcdefab_1234_5678_90ab_abcdefabcdef);
        assert!(same_guid("{ABCDEFAB-1234-5678-90AB-ABCDEFABCDEF}", guid));
    }

    #[test]
    fn v27_has_no_environment_specific_network_constants() {
        let source = include_str!("windows_hotspot_ics_v27.rs");
        for forbidden in ["CMCC-303-5G", "192.168.137.0/24", "ifIndex 23", "ifIndex 25", "ifIndex 55"] {
            assert!(!source.contains(forbidden));
        }
    }
}
