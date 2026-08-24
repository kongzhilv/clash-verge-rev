use std::{
    ffi::c_void,
    fs,
    path::{Path, PathBuf},
    ptr::null_mut,
    slice,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow, bail};
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
        System::Com::{
            CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
        },
    },
    core::GUID,
};

use crate::{
    config::Config,
    core::diagnostics,
    process::AsyncHandler,
    utils::dirs,
};

const LOOP_INTERVAL: Duration = Duration::from_secs(2);
const STABLE_SAMPLES: u8 = 3;
const SNAPSHOT_FILE: &str = "windows-hotspot-ics-lease-v20.json";
const CONNECTION_MANAGER: GUID = GUID::from_u128(0xba126ad1_2166_11d1_b1d0_00805fc1270e);
static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);

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
        bail!(
            "GetUnicastIpAddressTable failed with Windows error {}",
            status.0
        );
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
        tun: tun_candidates.into_iter().next().expect("one TUN candidate"),
        hotspot: hotspot_candidates
            .into_iter()
            .next()
            .expect("one hotspot candidate"),
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

fn snapshot_path() -> Result<PathBuf> {
    Ok(dirs::app_home_dir()?.join(SNAPSHOT_FILE))
}

fn save_snapshot(path: &Path, snapshot: &SavedSharingState) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(snapshot)?)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn load_snapshot(path: &Path) -> Result<Option<SavedSharingState>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
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

fn enumerate_connections(
    connection_manager: &INetConnectionManager,
) -> Result<Vec<INetConnection>> {
    let enumerator = unsafe { connection_manager.EnumConnections(NCME_DEFAULT) }
        .context("INetConnectionManager::EnumConnections failed")?;
    let mut result = Vec::new();
    loop {
        let mut slot: [Option<INetConnection>; 1] = [None];
        let mut fetched = 0u32;
        unsafe { enumerator.Next(&mut slot, &mut fetched) }
            .context("IEnumNetConnection::Next failed")?;
        if fetched == 0 {
            break;
        }
        if let Some(connection) = slot[0].take() {
            result.push(connection);
        }
    }
    Ok(result)
}

fn connection_log(
    manager: &INetSharingManager,
    connection: &INetConnection,
) -> Result<SharingStateLog> {
    let props = unsafe { manager.get_NetConnectionProps(connection) }
        .context("get_NetConnectionProps failed")?;
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

fn find_connection<'a>(
    manager: &INetSharingManager,
    connections: &'a [INetConnection],
    guid: GUID,
) -> Result<&'a INetConnection> {
    for connection in connections {
        let props = unsafe { manager.get_NetConnectionProps(connection) }?;
        let candidate = unsafe { props.Guid() }?;
        if same_guid(&candidate.to_string(), guid) {
            return Ok(connection);
        }
    }
    Err(anyhow!("network connection GUID {} was not found", guid_string(guid)))
}

fn current_shared_roles(
    manager: &INetSharingManager,
    connections: &[INetConnection],
) -> Result<Vec<SavedRole>> {
    let mut roles = Vec::new();
    for connection in connections {
        let state = connection_log(manager, connection)?;
        if let Some(role) = state.sharing_role {
            roles.push(SavedRole {
                guid: state.guid,
                role,
            });
        }
    }
    roles.sort_by(|left, right| left.guid.cmp(&right.guid));
    Ok(roles)
}

fn log_all_sharing_state(
    manager: &INetSharingManager,
    connections: &[INetConnection],
    event: &'static str,
) {
    let states = connections
        .iter()
        .filter_map(|connection| connection_log(manager, connection).ok())
        .collect::<Vec<_>>();
    diagnostics::info(
        "windows-hotspot-ics",
        event,
        json!({"connections": states}),
    );
}

fn role_of_guid(roles: &[SavedRole], guid: GUID) -> Option<SharingRole> {
    roles
        .iter()
        .find(|item| same_guid(&item.guid, guid))
        .map(|item| item.role)
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

fn restore_snapshot(path: &Path, snapshot: &SavedSharingState) -> Result<()> {
    let _apartment = ComApartment::init()?;
    let sharing_manager: INetSharingManager =
        unsafe { CoCreateInstance(&NetSharingManager, None, CLSCTX_ALL) }
            .context("create NetSharingManager failed")?;
    let connection_manager: INetConnectionManager =
        unsafe { CoCreateInstance(&CONNECTION_MANAGER, None, CLSCTX_ALL) }
            .context("create Network Connection Manager failed")?;
    let connections = enumerate_connections(&connection_manager)?;
    log_all_sharing_state(&sharing_manager, &connections, "restore-before");

    // Only undo connections that this lease intentionally touched: the leased TUN,
    // hotspot private side, and any original public connection Windows automatically
    // disabled when a new PUBLIC connection was enabled.
    for guid in [&snapshot.tun_guid, &snapshot.hotspot_guid] {
        if let Some(connection) = connections.iter().find(|connection| {
            unsafe { sharing_manager.get_NetConnectionProps(connection) }
                .and_then(|props| unsafe { props.Guid() })
                .is_ok_and(|candidate| normalize_guid(&candidate.to_string()) == normalize_guid(guid))
        }) {
            let config = sharing_configuration(&sharing_manager, connection)?;
            let enabled = unsafe { config.SharingEnabled() }?.0 != 0;
            if enabled {
                unsafe { config.DisableSharing() }?;
            }
        }
    }

    // PUBLIC must be restored before PRIVATE because Windows guarantees at most one
    // public shared connection and enabling one automatically disables the old PUBLIC.
    for wanted_role in [SharingRole::Public, SharingRole::Private] {
        for saved in snapshot
            .originally_shared
            .iter()
            .filter(|item| item.role == wanted_role)
        {
            let Some(connection) = connections.iter().find(|connection| {
                unsafe { sharing_manager.get_NetConnectionProps(connection) }
                    .and_then(|props| unsafe { props.Guid() })
                    .is_ok_and(|candidate| {
                        normalize_guid(&candidate.to_string()) == normalize_guid(&saved.guid)
                    })
            }) else {
                bail!("cannot restore missing ICS connection {}", saved.guid);
            };
            set_role(&sharing_configuration(&sharing_manager, connection)?, saved.role)?;
        }
    }

    log_all_sharing_state(&sharing_manager, &connections, "restore-after");
    remove_snapshot(path)?;
    Ok(())
}

fn apply_pair(path: &Path, pair: &TargetPair) -> Result<()> {
    let _apartment = ComApartment::init()?;
    let sharing_manager: INetSharingManager =
        unsafe { CoCreateInstance(&NetSharingManager, None, CLSCTX_ALL) }
            .context("create NetSharingManager failed")?;
    let connection_manager: INetConnectionManager =
        unsafe { CoCreateInstance(&CONNECTION_MANAGER, None, CLSCTX_ALL) }
            .context("create Network Connection Manager failed")?;
    let connections = enumerate_connections(&connection_manager)?;
    log_all_sharing_state(&sharing_manager, &connections, "apply-before");

    let original = current_shared_roles(&sharing_manager, &connections)?;
    let snapshot = SavedSharingState {
        version: 1,
        created_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        tun_guid: guid_string(pair.tun.guid),
        hotspot_guid: guid_string(pair.hotspot.guid),
        originally_shared: original.clone(),
    };
    save_snapshot(path, &snapshot)?;

    let tun = find_connection(&sharing_manager, &connections, pair.tun.guid)?;
    let hotspot = find_connection(&sharing_manager, &connections, pair.hotspot.guid)?;

    let apply_result = (|| -> Result<()> {
        set_role(&sharing_configuration(&sharing_manager, tun)?, SharingRole::Public)?;
        set_role(
            &sharing_configuration(&sharing_manager, hotspot)?,
            SharingRole::Private,
        )?;

        let after = current_shared_roles(&sharing_manager, &connections)?;
        if role_of_guid(&after, pair.tun.guid) != Some(SharingRole::Public)
            || role_of_guid(&after, pair.hotspot.guid) != Some(SharingRole::Private)
        {
            bail!("ICS role verification failed after EnableSharing");
        }
        Ok(())
    })();

    if let Err(error) = apply_result {
        diagnostics::error(
            "windows-hotspot-ics",
            "apply-verification-failed",
            json!({
                "error": error.to_string(),
                "action": "restore-original-ics-immediately",
            }),
        );
        drop(connections);
        drop(connection_manager);
        drop(sharing_manager);
        drop(_apartment);
        restore_snapshot(path, &snapshot).context("apply failed and rollback also failed")?;
        return Err(error);
    }

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
            },
            "hotspot": {
                "guid": guid_string(pair.hotspot.guid),
                "alias": pair.hotspot.alias,
                "description": pair.hotspot.description,
                "role": "private",
            },
            "originally_shared": original,
            "snapshot_file_present": true,
            "strategy": "mihomo-tun-as-ics-public-with-persistent-rollback",
        }),
    );
    Ok(())
}

fn reconcile_once(tun_enabled: bool, path: &Path) -> Result<&'static str> {
    let saved = load_snapshot(path)?;
    let pair = if tun_enabled { target_pair()? } else { None };

    match (saved, pair) {
        (Some(snapshot), Some(pair))
            if same_guid(&snapshot.tun_guid, pair.tun.guid)
                && same_guid(&snapshot.hotspot_guid, pair.hotspot.guid) =>
        {
            Ok("lease-already-active")
        }
        (Some(snapshot), _) => {
            restore_snapshot(path, &snapshot)?;
            Ok("lease-restored")
        }
        (None, Some(pair)) => {
            apply_pair(path, &pair)?;
            Ok("lease-applied")
        }
        (None, None) => Ok("no-action"),
    }
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
    let mut interval = tokio::time::interval(LOOP_INTERVAL);

    loop {
        interval.tick().await;
        let tun_enabled = Config::verge()
            .await
            .latest_arc()
            .enable_tun_mode
            .unwrap_or(false);

        let signature = tokio::task::spawn_blocking(move || -> Result<Option<String>> {
            let pair = if tun_enabled { target_pair()? } else { None };
            Ok(pair.map(|pair| {
                format!(
                    "{}:{}",
                    normalize_guid(&guid_string(pair.tun.guid)),
                    normalize_guid(&guid_string(pair.hotspot.guid))
                )
            }))
        })
        .await
        .map_err(|error| anyhow!("ICS target discovery task failed: {error}"));

        let signature = match signature {
            Ok(Ok(signature)) => signature,
            Ok(Err(error)) | Err(error) => {
                diagnostics::warn(
                    "windows-hotspot-ics",
                    "target-discovery-failed",
                    json!({"error": error.to_string()}),
                );
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
            Ok(Err(error)) => diagnostics::error(
                "windows-hotspot-ics",
                "reconcile-failed",
                json!({
                    "error": error.to_string(),
                    "stable_signature": current_signature,
                    "snapshot_file_present": path.exists(),
                    "action": "fail-closed-or-rollback",
                }),
            ),
            Err(error) => diagnostics::error(
                "windows-hotspot-ics",
                "reconcile-task-failed",
                json!({"error": error.to_string()}),
            ),
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
