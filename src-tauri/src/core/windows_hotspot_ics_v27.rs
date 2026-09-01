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

use crate::{
    config::Config,
    core::diagnostics,
    process::AsyncHandler,
    utils::{dirs, windows_network::detect_stable_upstream},
};

const LOOP_INTERVAL: Duration = Duration::from_secs(2);
const STABLE_SAMPLES: u8 = 3;
// Keep the historical path so an in-flight v20/v26 lease can always be read and
// restored during upgrade. Snapshot v3 is a backward-compatible schema extension.
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
    hotspot_windows_owned: bool,
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
    #[serde(default)]
    original_upstream_guid: Option<String>,
    #[serde(default)]
    hotspot_windows_owned: bool,
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

fn is_windows_mobile_hotspot_identity(identity: &str) -> bool {
    [
        "wi-fi direct virtual adapter",
        "wifi direct virtual adapter",
        "mobile hotspot",
    ]
    .iter()
    .any(|marker| identity.contains(marker))
}

fn is_mobile_hotspot_adapter(row: &MIB_IF_ROW2) -> bool {
    if row.OperStatus != IfOperStatusUp {
        return false;
    }
    let identity = interface_identity(row);
    !is_filter_component(&identity)
        && (is_windows_mobile_hotspot_identity(&identity)
            || ["microsoft hosted network", "hosted network virtual"]
                .iter()
                .any(|marker| identity.contains(marker)))
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

    let hotspot_rows = interfaces
        .iter()
        .filter(|row| is_mobile_hotspot_adapter(row) && has_private_ipv4(row.InterfaceIndex, &addresses))
        .collect::<Vec<_>>();

    if tun_candidates.is_empty() || hotspot_rows.is_empty() {
        return Ok(None);
    }
    if tun_candidates.len() != 1 || hotspot_rows.len() != 1 {
        diagnostics::warn(
            "windows-hotspot-ics",
            "target-identification-ambiguous",
            json!({
                "tun_candidates": tun_candidates.iter().map(|item| json!({
                    "guid": guid_string(item.guid),
                    "alias": item.alias,
                    "description": item.description,
                })).collect::<Vec<_>>(),
                "hotspot_candidates": hotspot_rows.iter().map(|row| json!({
                    "guid": guid_string(row.InterfaceGuid),
                    "alias": utf16z(&row.Alias),
                    "description": utf16z(&row.Description),
                })).collect::<Vec<_>>(),
                "action": "fail-closed-no-ics-mutation",
            }),
        );
        return Ok(None);
    }

    let Some(tun) = tun_candidates.into_iter().next() else {
        return Ok(None);
    };
    let Some(hotspot_row) = hotspot_rows.into_iter().next() else {
        return Ok(None);
    };
    let hotspot_identity = interface_identity(hotspot_row);

    Ok(Some(TargetPair {
        tun,
        hotspot: InterfaceIdentity {
            guid: hotspot_row.InterfaceGuid,
            alias: utf16z(&hotspot_row.Alias),
            description: utf16z(&hotspot_row.Description),
        },
        hotspot_windows_owned: is_windows_mobile_hotspot_identity(&hotspot_identity),
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
            if snapshot.version != 2 && snapshot.version != 3 {
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
    if state.sharing_role == desired {
        return Ok(false);
    }
    let configuration = sharing_configuration(manager, connection)?;
    match desired {
        Some(SharingRole::Public) => unsafe { configuration.EnableSharing(ICSSHARINGTYPE_PUBLIC) }
            .with_context(|| format!("{context}; adapter={}; guid={}", state.name, state.guid))?,
        Some(SharingRole::Private) => unsafe { configuration.EnableSharing(ICSSHARINGTYPE_PRIVATE) }
            .with_context(|| format!("{context}; adapter={}; guid={}", state.name, state.guid))?,
        None if state.sharing_role.is_some() => unsafe { configuration.DisableSharing() }
            .with_context(|| format!("{context}; adapter={}; guid={}", state.name, state.guid))?,
        None => return Ok(false),
    }
    Ok(true)
}

fn find_connection(
    manager: &INetSharingManager,
    connections: &[INetConnection],
    guid: &str,
) -> Result<Option<INetConnection>> {
    for connection in connections {
        let state = connection_log(manager, connection)?;
        if normalize_guid(&state.guid) == normalize_guid(guid) {
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

fn current_physical_upstream_guid() -> Option<String> {
    let upstream = detect_stable_upstream().ok()?;
    let interfaces = load_interfaces().ok()?;
    interfaces
        .iter()
        .find(|row| row.InterfaceIndex == upstream.interface_index && row.OperStatus == IfOperStatusUp)
        .map(|row| guid_string(row.InterfaceGuid))
}

fn require_dynamic_restore_anchor(guid: Option<String>, context: &'static str) -> Result<String> {
    guid.ok_or_else(|| anyhow!("{context}: no stable physical IPv4 default route is available"))
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

fn has_saved_public_role(roles: &[SavedRole]) -> bool {
    roles.iter().any(|item| item.role == SharingRole::Public)
}

fn restore_snapshot_unlocked(path: &Path, snapshot: &SavedSharingState) -> Result<()> {
    let (_apartment, sharing_manager, connection_manager) = create_managers()?;
    let connections = enumerate_connections(&connection_manager)?;
    log_all_sharing_state(&sharing_manager, &connections, "restore-before");

    let saved_public_exists = has_saved_public_role(&snapshot.originally_shared);
    let current_upstream_guid = if saved_public_exists {
        None
    } else {
        current_physical_upstream_guid()
    };
    let restore_upstream_guid = if saved_public_exists {
        None
    } else {
        Some(require_dynamic_restore_anchor(
            current_upstream_guid.clone(),
            "cannot restore Mobile Hotspot ICS lease without a stable current physical upstream",
        )?)
    };

    // Prefer the exact roles HNetCfg exposed before the lease. Modern Mobile
    // Hotspot can hide its Windows-owned PUBLIC role; in that case restore only
    // the currently re-confirmed stable physical default-route adapter. The
    // persisted pre-lease GUID remains diagnostic evidence, never a stale routing
    // fallback after Wi-Fi, Ethernet, USB or other upstream changes.
    if saved_public_exists {
        for saved in snapshot
            .originally_shared
            .iter()
            .filter(|item| item.role == SharingRole::Public)
        {
            let connection = find_connection(&sharing_manager, &connections, &saved.guid)?
                .ok_or_else(|| anyhow!("cannot restore original PUBLIC ICS connection {}", saved.guid))?;
            reconcile_connection_role(
                &sharing_manager,
                &connection,
                Some(SharingRole::Public),
                "restore original PUBLIC ICS role",
            )?;
        }
    } else {
        let guid = restore_upstream_guid
            .as_deref()
            .ok_or_else(|| anyhow!("missing validated current physical upstream restore anchor"))?;
        let connection = find_connection(&sharing_manager, &connections, guid)?
            .ok_or_else(|| anyhow!("current physical Mobile Hotspot upstream disappeared before restore: {guid}"))?;
        reconcile_connection_role(
            &sharing_manager,
            &connection,
            Some(SharingRole::Public),
            "restore current physical Mobile Hotspot upstream as PUBLIC",
        )?;
    }

    for saved in snapshot
        .originally_shared
        .iter()
        .filter(|item| item.role == SharingRole::Private)
    {
        if let Some(connection) = find_connection(&sharing_manager, &connections, &saved.guid)? {
            reconcile_connection_role(
                &sharing_manager,
                &connection,
                Some(SharingRole::Private),
                "restore original PRIVATE ICS role",
            )?;
        }
    }

    // TUN is lease-owned unless it was already shared. Always remove that lease
    // role when appropriate. A Windows-owned Mobile Hotspot private side is
    // intentionally preserved/re-established because HNetCfg may have reported it
    // as unshared before we took the lease even though tethering was active.
    if role_of_saved_guid(&snapshot.originally_shared, &snapshot.tun_guid).is_none()
        && let Some(connection) = find_connection(&sharing_manager, &connections, &snapshot.tun_guid)?
    {
        reconcile_connection_role(
            &sharing_manager,
            &connection,
            None,
            "remove lease-owned TUN PUBLIC role during restore",
        )?;
    }

    if role_of_saved_guid(&snapshot.originally_shared, &snapshot.hotspot_guid).is_none() {
        if snapshot.hotspot_windows_owned {
            if let Some(connection) = find_connection(&sharing_manager, &connections, &snapshot.hotspot_guid)? {
                reconcile_connection_role(
                    &sharing_manager,
                    &connection,
                    Some(SharingRole::Private),
                    "preserve Windows Mobile Hotspot PRIVATE side during restore",
                )?;
            }
        } else if let Some(connection) = find_connection(&sharing_manager, &connections, &snapshot.hotspot_guid)? {
            reconcile_connection_role(
                &sharing_manager,
                &connection,
                None,
                "remove lease-owned legacy hotspot PRIVATE role during restore",
            )?;
        }
    }

    let after = current_shared_roles(&sharing_manager, &connections)?;
    for saved in &snapshot.originally_shared {
        if find_connection(&sharing_manager, &connections, &saved.guid)?.is_some()
            && role_of_saved_guid(&after, &saved.guid) != Some(saved.role)
        {
            bail!("original ICS role was not restored for {}", saved.guid);
        }
    }
    if !saved_public_exists {
        let guid = restore_upstream_guid
            .as_deref()
            .ok_or_else(|| anyhow!("missing validated current physical upstream during restore readback"))?;
        if role_of_saved_guid(&after, guid) != Some(SharingRole::Public) {
            bail!("current physical upstream was not restored as PUBLIC");
        }
    }

    log_all_sharing_state(&sharing_manager, &connections, "restore-after");
    remove_snapshot(path)?;
    diagnostics::info(
        "windows-hotspot-ics",
        "lease-restored",
        json!({
            "version": 27,
            "saved_public_visible": saved_public_exists,
            "current_physical_upstream_guid": current_upstream_guid,
            "snapshot_upstream_guid": snapshot.original_upstream_guid,
            "restored_upstream_guid": restore_upstream_guid,
            "hotspot_windows_owned": snapshot.hotspot_windows_owned,
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

    let tun_guid = guid_string(pair.tun.guid);
    let hotspot_guid = guid_string(pair.hotspot.guid);
    let tun = find_connection(&sharing_manager, &connections, &tun_guid)?
        .ok_or_else(|| anyhow!("Mihomo TUN connection disappeared before ICS apply"))?;
    let hotspot = find_connection(&sharing_manager, &connections, &hotspot_guid)?
        .ok_or_else(|| anyhow!("Mobile Hotspot connection disappeared before ICS apply"))?;

    let saved_public_exists = has_saved_public_role(&original);
    let original_upstream_guid = if saved_public_exists {
        None
    } else {
        Some(require_dynamic_restore_anchor(
            current_physical_upstream_guid(),
            "refusing to acquire Mobile Hotspot ICS lease without a stable physical upstream restore anchor",
        )?)
    };

    let snapshot = SavedSharingState {
        version: 3,
        created_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        tun_guid: tun_guid.clone(),
        hotspot_guid: hotspot_guid.clone(),
        originally_shared: lease_owned_original_roles(&original, pair),
        original_upstream_guid: original_upstream_guid.clone(),
        hotspot_windows_owned: pair.hotspot_windows_owned,
    };
    save_snapshot(path, &snapshot)?;

    diagnostics::info(
        "windows-hotspot-ics",
        "apply-plan",
        json!({
            "tun_guid": tun_guid,
            "hotspot_guid": hotspot_guid,
            "hotspot_windows_owned": pair.hotspot_windows_owned,
            "original_upstream_guid": original_upstream_guid,
            "saved_public_visible": saved_public_exists,
            "saved_hnetcfg_roles": &original,
            "order": "hotspot-private-then-tun-public",
            "reason": "forwarded hotspot traffic must enter Mihomo before physical egress",
        }),
    );

    let apply_result = (|| -> Result<()> {
        reconcile_connection_role(
            &sharing_manager,
            &hotspot,
            Some(SharingRole::Private),
            "apply active hotspot PRIVATE role before TUN PUBLIC",
        )?;
        std::thread::sleep(Duration::from_millis(500));

        reconcile_connection_role(
            &sharing_manager,
            &tun,
            Some(SharingRole::Public),
            "apply Mihomo TUN PUBLIC role after hotspot PRIVATE preparation",
        )?;
        std::thread::sleep(Duration::from_millis(250));

        let after = current_shared_roles(&sharing_manager, &connections)?;
        if !lease_roles_are_desired(&after, pair) {
            bail!("ICS role verification failed after Mobile Hotspot TUN lease apply");
        }
        Ok(())
    })();

    if let Err(error) = apply_result {
        diagnostics::error(
            "windows-hotspot-ics",
            "lease-apply-failed",
            json!({
                "error": format!("{error:#}"),
                "action": "rollback-immediately",
            }),
        );
        restore_snapshot_unlocked(path, &snapshot).context("apply failed and rollback also failed")?;
        return Err(error);
    }

    log_all_sharing_state(&sharing_manager, &connections, "apply-after");
    diagnostics::info(
        "windows-hotspot-ics",
        "lease-applied",
        json!({
            "version": 27,
            "tun": {
                "guid": guid_string(pair.tun.guid),
                "alias_observed": pair.tun.alias,
                "description_observed": pair.tun.description,
                "role": "public",
            },
            "hotspot": {
                "guid": guid_string(pair.hotspot.guid),
                "alias_observed": pair.hotspot.alias,
                "description_observed": pair.hotspot.description,
                "role": "private",
                "windows_owned": pair.hotspot_windows_owned,
            },
            "original_upstream_guid": snapshot.original_upstream_guid,
            "strategy": "dynamic-guid-mobile-hotspot-private-to-mihomo-tun-public",
            "hardcoded_upstream_interface": false,
            "hardcoded_hotspot_subnet": false,
            "persistent_rollback": true,
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
            let (_apartment, manager, connection_manager) = create_managers()?;
            let connections = enumerate_connections(&connection_manager)?;
            let roles = current_shared_roles(&manager, &connections)?;
            if lease_roles_are_desired(&roles, &pair) {
                Ok("lease-already-active")
            } else {
                diagnostics::warn(
                    "windows-hotspot-ics",
                    "lease-drift-detected",
                    json!({
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
            "version": 27,
            "poll_interval_ms": LOOP_INTERVAL.as_millis(),
            "stable_samples": STABLE_SAMPLES,
            "target_identification": "runtime-interface-guid+device-class+private-ip",
            "upstream_restore_identity": "stable-native-physical-default-route-guid",
            "mutation_api": "native-hnetcfg-com",
            "desired_topology": "mihomo-tun=ics-public;active-mobile-hotspot=ics-private",
            "generic": true,
            "persistent_rollback": true,
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
            Ok(target_pair()?.map(|pair| {
                format!(
                    "{}:{}",
                    normalize_guid(&guid_string(pair.tun.guid)),
                    normalize_guid(&guid_string(pair.hotspot.guid))
                )
            }))
        })
        .await;

        let signature = match signature {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                let message = error.to_string();
                if message != last_error {
                    diagnostics::warn(
                        "windows-hotspot-ics",
                        "target-discovery-failed",
                        json!({"error": message}),
                    );
                    last_error = message;
                }
                continue;
            }
            Err(error) => {
                let message = error.to_string();
                if message != last_error {
                    diagnostics::warn(
                        "windows-hotspot-ics",
                        "target-discovery-task-failed",
                        json!({"error": message}),
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
        match tokio::task::spawn_blocking(move || reconcile_once(tun_enabled, &path_for_task)).await {
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
                let message = format!("{error:#}");
                if message != last_error {
                    diagnostics::error(
                        "windows-hotspot-ics",
                        "reconcile-failed",
                        json!({
                            "error": message,
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
            hotspot_windows_owned: true,
        }
    }

    #[test]
    fn v27_lease_requires_tun_public_and_hotspot_private_by_guid() {
        let pair = pair();
        let desired = vec![
            SavedRole {
                guid: guid_string(pair.tun.guid),
                role: SharingRole::Public,
            },
            SavedRole {
                guid: guid_string(pair.hotspot.guid),
                role: SharingRole::Private,
            },
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
            SavedRole {
                guid: format!("{:?}", GUID::from_u128(0x33333333_3333_3333_3333_333333333333)),
                role: SharingRole::Public,
            },
            SavedRole {
                guid: guid_string(pair.hotspot.guid),
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
        assert!(retained.iter().any(|item| same_guid(&item.guid, pair.hotspot.guid)));
    }

    #[test]
    fn v27_guid_matching_is_alias_and_ifindex_independent() {
        let guid = GUID::from_u128(0xabcdefab_1234_5678_90ab_abcdefabcdef);
        assert!(same_guid("{ABCDEFAB-1234-5678-90AB-ABCDEFABCDEF}", guid));
    }

    #[test]
    fn v27_hidden_windows_hotspot_state_persists_dynamic_restore_anchor() {
        let pair = pair();
        let snapshot = SavedSharingState {
            version: 3,
            created_unix_ms: 0,
            tun_guid: guid_string(pair.tun.guid),
            hotspot_guid: guid_string(pair.hotspot.guid),
            originally_shared: Vec::new(),
            original_upstream_guid: Some("{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}".into()),
            hotspot_windows_owned: true,
        };
        assert!(!has_saved_public_role(&snapshot.originally_shared));
        assert!(snapshot.original_upstream_guid.is_some());
        assert!(snapshot.hotspot_windows_owned);
    }

    #[test]
    fn v27_dynamic_restore_anchor_fails_closed_when_physical_route_is_unavailable() {
        assert!(require_dynamic_restore_anchor(None, "test restore anchor").is_err());
    }

    #[test]
    fn v27_dynamic_restore_anchor_accepts_stable_native_physical_guid() {
        let guid = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}".to_owned();
        assert_eq!(
            require_dynamic_restore_anchor(Some(guid.clone()), "test restore anchor").unwrap(),
            guid
        );
    }

    #[test]
    fn v27_identity_logic_is_guid_based_and_alias_independent() {
        let pair = pair();
        let tun_guid = guid_string(pair.tun.guid);
        let hotspot_guid = guid_string(pair.hotspot.guid);
        assert_ne!(normalize_guid(&tun_guid), normalize_guid(&hotspot_guid));
        assert!(pair.tun.alias.contains("tun"));
        assert!(pair.hotspot.alias.contains("alias"));
        assert!(pair.hotspot_windows_owned);
    }
}
