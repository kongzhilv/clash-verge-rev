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
const SNAPSHOT_FILE: &str = "windows-hotspot-ics-lease-v20.json";
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RoleMutation {
    None,
    Enable(SharingRole),
    Disable,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct SharingStateLog {
    guid: String,
    name: String,
    device_name: String,
    sharing_enabled: bool,
    sharing_role: Option<SharingRole>,
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
    let family = unsafe { value.si_family };
    if family != AF_INET {
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

fn is_hotspot_adapter(row: &MIB_IF_ROW2) -> bool {
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

    let mut tun_candidates = interfaces
        .iter()
        .filter(|row| is_mihomo_tun(row))
        .map(|row| InterfaceIdentity {
            guid: row.InterfaceGuid,
            alias: utf16z(&row.Alias),
            description: utf16z(&row.Description),
        })
        .collect::<Vec<_>>();
    let mut hotspot_candidates = interfaces
        .iter()
        .filter(|row| is_hotspot_adapter(row) && has_private_ipv4(row.InterfaceIndex, &addresses))
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
                    "guid": guid_string(item.guid),
                    "alias": item.alias,
                    "description": item.description,
                })).collect::<Vec<_>>(),
                "hotspot_candidates": hotspot_candidates.iter().map(|item| json!({
                    "guid": guid_string(item.guid),
                    "alias": item.alias,
                    "description": item.description,
                })).collect::<Vec<_>>(),
                "action": "fail-closed-no-ics-mutation",
            }),
        );
        return Ok(None);
    }

    Ok(Some(TargetPair {
        tun: tun_candidates.remove(0),
        hotspot: hotspot_candidates.remove(0),
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

fn role_of_saved_guid(roles: &[SavedRole], guid: &str) -> Option<SharingRole> {
    roles
        .iter()
        .find(|item| normalize_guid(&item.guid) == normalize_guid(guid))
        .map(|item| item.role)
}

fn role_mutation(current: Option<SharingRole>, desired: Option<SharingRole>) -> RoleMutation {
    match (current, desired) {
        (current, desired) if current == desired => RoleMutation::None,
        (_, Some(role)) => RoleMutation::Enable(role),
        (Some(_), None) => RoleMutation::Disable,
        (None, None) => RoleMutation::None,
    }
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
            if snapshot.version != 2 {
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

fn connection_log(manager: &INetSharingManager, connection: &INetConnection) -> Result<SharingStateLog> {
    let props = unsafe { manager.get_NetConnectionProps(connection) }.context("get_NetConnectionProps failed")?;
    let guid = unsafe { props.Guid() }.context("INetConnectionProps::Guid failed")?;
    let name = unsafe { props.Name() }.context("INetConnectionProps::Name failed")?;
    let device_name = unsafe { props.DeviceName() }.context("INetConnectionProps::DeviceName failed")?;
    let sharing = unsafe { manager.get_INetSharingConfigurationForINetConnection(connection) }
        .context("get_INetSharingConfigurationForINetConnection failed")?;
    let enabled = unsafe { sharing.SharingEnabled() }
        .context("INetSharingConfiguration::SharingEnabled failed")?
        .0
        != 0;
    let role = if enabled {
        let raw = unsafe { sharing.SharingConnectionType() }
            .context("INetSharingConfiguration::SharingConnectionType failed")?;
        if raw == ICSSHARINGTYPE_PUBLIC {
            Some(SharingRole::Public)
        } else if raw == ICSSHARINGTYPE_PRIVATE {
            Some(SharingRole::Private)
        } else {
            None
        }
    } else {
        None
    };
    Ok(SharingStateLog {
        guid: guid.to_string(),
        name: name.to_string(),
        device_name: device_name.to_string(),
        sharing_enabled: enabled,
        sharing_role: role,
    })
}

fn sharing_configuration(
    manager: &INetSharingManager,
    connection: &INetConnection,
) -> Result<INetSharingConfiguration> {
    unsafe { manager.get_INetSharingConfigurationForINetConnection(connection) }
        .context("get_INetSharingConfigurationForINetConnection failed")
}

fn reconcile_connection_role(
    manager: &INetSharingManager,
    connection: &INetConnection,
    desired: Option<SharingRole>,
    context: &'static str,
) -> Result<bool> {
    let state = connection_log(manager, connection)?;
    let mutation = role_mutation(state.sharing_role, desired);
    let configuration = sharing_configuration(manager, connection)?;

    match mutation {
        RoleMutation::None => Ok(false),
        RoleMutation::Enable(role) => {
            set_role(&configuration, role).with_context(|| context)?;
            Ok(true)
        }
        RoleMutation::Disable => {
            unsafe { configuration.DisableSharing() }.with_context(|| context)?;
            Ok(true)
        }
    }
}

fn find_connection(
    manager: &INetSharingManager,
    connections: &[INetConnection],
    guid: GUID,
) -> Result<Option<INetConnection>> {
    for connection in connections {
        let props = unsafe { manager.get_NetConnectionProps(connection) }
            .context("get_NetConnectionProps failed while matching GUID")?;
        let candidate = unsafe { props.Guid() }.context("INetConnectionProps::Guid failed while matching GUID")?;
        if same_guid(&candidate.to_string(), guid) {
            return Ok(Some(connection.clone()));
        }
    }
    Ok(None)
}

fn find_connection_by_saved_guid(
    manager: &INetSharingManager,
    connections: &[INetConnection],
    guid: &str,
) -> Result<Option<INetConnection>> {
    for connection in connections {
        let props = unsafe { manager.get_NetConnectionProps(connection) }
            .context("get_NetConnectionProps failed while matching saved GUID")?;
        let candidate =
            unsafe { props.Guid() }.context("INetConnectionProps::Guid failed while matching saved GUID")?;
        if normalize_guid(&candidate.to_string()) == normalize_guid(guid) {
            return Ok(Some(connection.clone()));
        }
    }
    Ok(None)
}

fn current_shared_roles(manager: &INetSharingManager, connections: &[INetConnection]) -> Result<Vec<SavedRole>> {
    let mut roles = Vec::new();
    for connection in connections {
        let state = connection_log(manager, connection)?;
        if let Some(role) = state.sharing_role {
            roles.push(SavedRole { guid: state.guid, role });
        }
    }
    roles.sort_by(|left, right| left.guid.cmp(&right.guid));
    Ok(roles)
}

fn log_all_sharing_state(manager: &INetSharingManager, connections: &[INetConnection], event: &'static str) {
    let states = connections
        .iter()
        .filter_map(|connection| connection_log(manager, connection).ok())
        .collect::<Vec<_>>();
    diagnostics::info("windows-hotspot-ics", event, json!({"connections": states}));
}

fn role_of_guid(roles: &[SavedRole], guid: GUID) -> Option<SharingRole> {
    roles
        .iter()
        .find(|item| same_guid(&item.guid, guid))
        .map(|item| item.role)
}

fn lease_roles_are_desired(roles: &[SavedRole], pair: &TargetPair) -> bool {
    role_of_guid(roles, pair.tun.guid) == Some(SharingRole::Public)
        && role_of_guid(roles, pair.hotspot.guid) == Some(SharingRole::Private)
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

fn set_role(configuration: &INetSharingConfiguration, role: SharingRole) -> Result<()> {
    unsafe {
        match role {
            SharingRole::Public => configuration.EnableSharing(ICSSHARINGTYPE_PUBLIC),
            SharingRole::Private => configuration.EnableSharing(ICSSHARINGTYPE_PRIVATE),
        }
    }
    .context("INetSharingConfiguration::EnableSharing failed")
}

fn create_managers() -> Result<(ComApartment, INetSharingManager, INetConnectionManager)> {
    let apartment = ComApartment::init()?;
    let sharing_manager: INetSharingManager =
        unsafe { CoCreateInstance(&NetSharingManager, None, CLSCTX_ALL) }.context("create NetSharingManager failed")?;
    let connection_manager: INetConnectionManager = unsafe { CoCreateInstance(&CONNECTION_MANAGER, None, CLSCTX_ALL) }
        .context("create Network Connection Manager failed")?;
    Ok((apartment, sharing_manager, connection_manager))
}

fn read_lease_roles(pair: &TargetPair) -> Result<Vec<SavedRole>> {
    let (_apartment, sharing_manager, connection_manager) = create_managers()?;
    let connections = enumerate_connections(&connection_manager)?;
    let roles = current_shared_roles(&sharing_manager, &connections)?;
    diagnostics::info(
        "windows-hotspot-ics",
        "lease-readback",
        json!({
            "tun_guid": guid_string(pair.tun.guid),
            "hotspot_guid": guid_string(pair.hotspot.guid),
            "roles": &roles,
            "desired": lease_roles_are_desired(&roles, pair),
        }),
    );
    Ok(roles)
}

fn restore_snapshot_unlocked(path: &Path, snapshot: &SavedSharingState) -> Result<()> {
    let (_apartment, sharing_manager, connection_manager) = create_managers()?;
    let connections = enumerate_connections(&connection_manager)?;
    log_all_sharing_state(&sharing_manager, &connections, "restore-before");

    let mut mutations = 0u8;

    // Restore the original PUBLIC first. Windows ICS automatically disables the
    // previously shared PUBLIC connection when another connection becomes PUBLIC,
    // so this avoids explicitly bouncing the hotspot PRIVATE side.
    for saved in snapshot
        .originally_shared
        .iter()
        .filter(|item| item.role == SharingRole::Public)
    {
        match find_connection_by_saved_guid(&sharing_manager, &connections, &saved.guid)? {
            Some(connection) => {
                if reconcile_connection_role(
                    &sharing_manager,
                    &connection,
                    Some(SharingRole::Public),
                    "restore original PUBLIC ICS role",
                )? {
                    mutations = mutations.saturating_add(1);
                }
            }
            None => bail!("cannot restore original PUBLIC ICS connection {}", saved.guid),
        }
    }

    // Restore PRIVATE roles only when they actually drifted. In the normal Mobile
    // Hotspot case the hotspot was already PRIVATE before the VPN lease, so this is
    // deliberately a no-op and avoids an unnecessary Disable/Enable cycle.
    for saved in snapshot
        .originally_shared
        .iter()
        .filter(|item| item.role == SharingRole::Private)
    {
        match find_connection_by_saved_guid(&sharing_manager, &connections, &saved.guid)? {
            Some(connection) => {
                if reconcile_connection_role(
                    &sharing_manager,
                    &connection,
                    Some(SharingRole::Private),
                    "restore original PRIVATE ICS role",
                )? {
                    mutations = mutations.saturating_add(1);
                }
            }
            None => diagnostics::info(
                "windows-hotspot-ics",
                "restore-private-target-missing",
                json!({
                    "guid": saved.guid,
                    "action": "skip-ephemeral-private-adapter",
                }),
            ),
        }
    }

    // If a lease target was originally unshared, remove only that lease-owned role.
    // Targets that already had their desired original role are left untouched.
    for guid in [&snapshot.tun_guid, &snapshot.hotspot_guid] {
        if role_of_saved_guid(&snapshot.originally_shared, guid).is_some() {
            continue;
        }
        if let Some(connection) = find_connection_by_saved_guid(&sharing_manager, &connections, guid)?
            && reconcile_connection_role(
                &sharing_manager,
                &connection,
                None,
                "remove lease-owned ICS role during restore",
            )?
        {
            mutations = mutations.saturating_add(1);
        }
    }

    let after = current_shared_roles(&sharing_manager, &connections)?;
    for saved in &snapshot.originally_shared {
        if find_connection_by_saved_guid(&sharing_manager, &connections, &saved.guid)?.is_some()
            && role_of_saved_guid(&after, &saved.guid) != Some(saved.role)
        {
            bail!("original ICS role was not restored for {}", saved.guid);
        }
    }
    for guid in [&snapshot.tun_guid, &snapshot.hotspot_guid] {
        if role_of_saved_guid(&snapshot.originally_shared, guid).is_none()
            && find_connection_by_saved_guid(&sharing_manager, &connections, guid)?.is_some()
            && role_of_saved_guid(&after, guid).is_some()
        {
            bail!("lease-owned ICS role remained after restore for {guid}");
        }
    }

    log_all_sharing_state(&sharing_manager, &connections, "restore-after");
    remove_snapshot(path)?;
    diagnostics::info(
        "windows-hotspot-ics",
        "lease-restored",
        json!({
            "rollback_scope": "minimal-diff-original-public+lease-targets-only",
            "mutations": mutations,
            "hotspot_private_preserved_when_unchanged": true,
            "snapshot_removed": true,
        }),
    );
    Ok(())
}

fn apply_pair_unlocked(path: &Path, pair: &TargetPair) -> Result<()> {
    let (_apartment, sharing_manager, connection_manager) = create_managers()?;
    let connections = enumerate_connections(&connection_manager)?;
    log_all_sharing_state(&sharing_manager, &connections, "apply-before");

    let original = current_shared_roles(&sharing_manager, &connections)?;
    if has_unrelated_private_role(&original, pair) {
        diagnostics::warn(
            "windows-hotspot-ics",
            "lease-refused-unrelated-private-sharing",
            json!({
                "originally_shared": &original,
                "action": "fail-closed-preserve-unrelated-private-ics",
            }),
        );
        bail!("refusing to replace an unrelated existing PRIVATE ICS connection");
    }

    // Resolve both COM connections before persisting rollback state. If either target
    // vanished during the stability window, no mutation has happened and no stale
    // snapshot is left behind for the next reconcile pass to misinterpret.
    let tun = find_connection(&sharing_manager, &connections, pair.tun.guid)?
        .ok_or_else(|| anyhow!("Mihomo TUN connection disappeared before ICS apply"))?;
    let hotspot = find_connection(&sharing_manager, &connections, pair.hotspot.guid)?
        .ok_or_else(|| anyhow!("Mobile Hotspot connection disappeared before ICS apply"))?;

    let snapshot = SavedSharingState {
        version: 2,
        created_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        tun_guid: guid_string(pair.tun.guid),
        hotspot_guid: guid_string(pair.hotspot.guid),
        originally_shared: lease_owned_original_roles(&original, pair),
    };
    save_snapshot(path, &snapshot)?;

    let apply_result = (|| -> Result<(bool, bool)> {
        let tun_changed = reconcile_connection_role(
            &sharing_manager,
            &tun,
            Some(SharingRole::Public),
            "apply Mihomo TUN PUBLIC ICS role",
        )?;
        let hotspot_changed = reconcile_connection_role(
            &sharing_manager,
            &hotspot,
            Some(SharingRole::Private),
            "apply Mobile Hotspot PRIVATE ICS role",
        )?;

        let after = current_shared_roles(&sharing_manager, &connections)?;
        if !lease_roles_are_desired(&after, pair) {
            bail!("ICS role verification failed after minimal-diff apply");
        }
        Ok((tun_changed, hotspot_changed))
    })();

    let (tun_changed, hotspot_changed) = match apply_result {
        Ok(changed) => changed,
        Err(error) => {
            diagnostics::error(
                "windows-hotspot-ics",
                "apply-verification-failed",
                json!({
                    "error": error.to_string(),
                    "action": "restore-original-ics-immediately",
                }),
            );
            restore_snapshot_unlocked(path, &snapshot).context("apply failed and rollback also failed")?;
            return Err(error);
        }
    };

    log_all_sharing_state(&sharing_manager, &connections, "apply-after");
    diagnostics::info(
        "windows-hotspot-ics",
        "lease-applied",
        json!({
            "tun": {
                "guid": guid_string(pair.tun.guid),
                "alias": pair.tun.alias,
                "description": pair.tun.description,
                "role": "public",
                "mutated": tun_changed,
            },
            "hotspot": {
                "guid": guid_string(pair.hotspot.guid),
                "alias": pair.hotspot.alias,
                "description": pair.hotspot.description,
                "role": "private",
                "mutated": hotspot_changed,
            },
            "originally_shared": original,
            "snapshot_file_present": true,
            "rollback_scope": "minimal-diff-original-public+lease-targets-only",
            "strategy": "mihomo-tun-as-ics-public-with-minimal-diff-persistent-rollback",
        }),
    );
    Ok(())
}

fn mutation_guard() -> Result<std::sync::MutexGuard<'static, ()>> {
    MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow!("Windows hotspot ICS mutation lock was poisoned"))
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
            let roles = read_lease_roles(&pair)?;
            if lease_roles_are_desired(&roles, &pair) {
                Ok("lease-already-active")
            } else {
                diagnostics::warn(
                    "windows-hotspot-ics",
                    "lease-drift-detected",
                    json!({
                        "tun_guid": guid_string(pair.tun.guid),
                        "hotspot_guid": guid_string(pair.hotspot.guid),
                        "observed_roles": roles,
                        "action": "restore-before-next-reapply",
                    }),
                );
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
        let Some(snapshot) = load_snapshot(&path_for_task)? else {
            return Ok(false);
        };
        restore_snapshot_unlocked(&path_for_task, &snapshot)?;
        Ok(true)
    })
    .await
    .context("Windows ICS explicit restore task failed")??;

    diagnostics::info(
        "windows-hotspot-ics",
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
        "windows-hotspot-ics",
        "monitor-started",
        json!({
            "poll_interval_ms": LOOP_INTERVAL.as_millis(),
            "stable_samples": STABLE_SAMPLES,
            "target_identification": "ip-helper-interface-guid+device-classification",
            "mutation_api": "native-hnetcfg-com",
            "powershell": false,
            "persistent_rollback": true,
            "rollback_scope": "minimal-diff-original-public+lease-targets-only",
            "unrelated_private_ics_policy": "fail-closed",
            "shutdown_restore_gate": true,
            "active_lease_readback": true,
            "hotspot_private_preserved_when_unchanged": true,
            "desired_topology": "mihomo-tun=public,windows-mobile-hotspot=private",
        }),
    );

    let path = match snapshot_path() {
        Ok(path) => path,
        Err(error) => {
            diagnostics::error(
                "windows-hotspot-ics",
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

        let signature = tokio::task::spawn_blocking(move || -> Result<Option<String>> {
            if !tun_enabled || restore_requested {
                return Ok(None);
            }
            let pair = target_pair()?;
            Ok(pair.map(|pair| {
                format!(
                    "{}:{}",
                    normalize_guid(&guid_string(pair.tun.guid)),
                    normalize_guid(&guid_string(pair.hotspot.guid))
                )
            }))
        })
        .await;

        let signature = match signature {
            Ok(Ok(signature)) => signature,
            Ok(Err(error)) => {
                let message = format!("discovery: {error}");
                if message != last_error {
                    diagnostics::warn(
                        "windows-hotspot-ics",
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
                        "windows-hotspot-ics",
                        "target-discovery-failed",
                        json!({"error": error.to_string(), "error_kind": "join"}),
                    );
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
        let outcome = tokio::task::spawn_blocking(move || reconcile_once(tun_enabled, &path_for_task)).await;
        match outcome {
            Ok(Ok(outcome)) => {
                last_error.clear();
                if outcome != last_outcome {
                    diagnostics::info(
                        "windows-hotspot-ics",
                        "reconcile-succeeded",
                        json!({
                            "outcome": outcome,
                            "stable_signature": current_signature,
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
                        "windows-hotspot-ics",
                        "reconcile-failed",
                        json!({
                            "error": message,
                            "stable_signature": current_signature,
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
                        "windows-hotspot-ics",
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
    use super::{
        InterfaceIdentity, RoleMutation, SavedRole, SharingRole, TargetPair, has_unrelated_private_role,
        lease_owned_original_roles, lease_roles_are_desired, normalize_guid, role_mutation, role_of_saved_guid,
    };
    use windows::core::GUID;

    fn pair() -> TargetPair {
        TargetPair {
            tun: InterfaceIdentity {
                guid: GUID::from_u128(0x11111111_1111_1111_1111_111111111111),
                alias: "Meta".into(),
                description: "Meta Tunnel".into(),
            },
            hotspot: InterfaceIdentity {
                guid: GUID::from_u128(0x22222222_2222_2222_2222_222222222222),
                alias: "Hotspot".into(),
                description: "Microsoft Wi-Fi Direct Virtual Adapter".into(),
            },
        }
    }

    #[test]
    fn windows_network_guid_normalization_ignores_braces_case_and_space() {
        assert_eq!(
            normalize_guid(" {ABCDEFAB-1234-5678-90AB-ABCDEFABCDEF} "),
            "abcdefab-1234-5678-90ab-abcdefabcdef"
        );
    }

    #[test]
    fn windows_network_rollback_scope_keeps_public_and_lease_targets_only() {
        let pair = pair();
        let roles = vec![
            SavedRole {
                guid: format!("{:?}", GUID::from_u128(0x33333333_3333_3333_3333_333333333333)),
                role: SharingRole::Public,
            },
            SavedRole {
                guid: format!("{:?}", pair.hotspot.guid),
                role: SharingRole::Private,
            },
            SavedRole {
                guid: format!("{:?}", GUID::from_u128(0x44444444_4444_4444_4444_444444444444)),
                role: SharingRole::Private,
            },
        ];
        let retained = lease_owned_original_roles(&roles, &pair);
        assert_eq!(retained.len(), 2);
        assert!(retained.iter().any(|item| item.role == SharingRole::Public));
        assert!(
            retained
                .iter()
                .any(|item| { normalize_guid(&item.guid) == normalize_guid(&format!("{:?}", pair.hotspot.guid)) })
        );
    }

    #[test]
    fn windows_network_unrelated_private_ics_is_fail_closed() {
        let pair = pair();
        let roles = vec![SavedRole {
            guid: format!("{:?}", GUID::from_u128(0x55555555_5555_5555_5555_555555555555)),
            role: SharingRole::Private,
        }];
        assert!(has_unrelated_private_role(&roles, &pair));
    }

    #[test]
    fn windows_network_active_lease_requires_both_expected_roles() {
        let pair = pair();
        let desired = vec![
            SavedRole {
                guid: format!("{:?}", pair.tun.guid),
                role: SharingRole::Public,
            },
            SavedRole {
                guid: format!("{:?}", pair.hotspot.guid),
                role: SharingRole::Private,
            },
        ];
        assert!(lease_roles_are_desired(&desired, &pair));

        let drifted = vec![SavedRole {
            guid: format!("{:?}", pair.tun.guid),
            role: SharingRole::Public,
        }];
        assert!(!lease_roles_are_desired(&drifted, &pair));
    }

    #[test]
    fn windows_network_minimal_diff_preserves_existing_hotspot_private_role() {
        assert_eq!(
            role_mutation(Some(SharingRole::Private), Some(SharingRole::Private)),
            RoleMutation::None
        );
        assert_eq!(
            role_mutation(Some(SharingRole::Public), Some(SharingRole::Public)),
            RoleMutation::None
        );
    }

    #[test]
    fn windows_network_minimal_diff_only_disables_originally_unshared_target() {
        assert_eq!(role_mutation(Some(SharingRole::Private), None), RoleMutation::Disable);
        assert_eq!(role_mutation(None, None), RoleMutation::None);
    }

    #[test]
    fn windows_network_saved_role_lookup_is_guid_normalized() {
        let roles = vec![SavedRole {
            guid: "{ABCDEFAB-1234-5678-90AB-ABCDEFABCDEF}".into(),
            role: SharingRole::Private,
        }];
        assert_eq!(
            role_of_saved_guid(&roles, "abcdefab-1234-5678-90ab-abcdefabcdef"),
            Some(SharingRole::Private)
        );
    }
}
