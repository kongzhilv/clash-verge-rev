use std::{
    collections::BTreeMap,
    ffi::c_void,
    net::Ipv4Addr,
    ptr::null_mut,
    slice,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};

use anyhow::{Result, anyhow};
use serde::Serialize;
use serde_json::json;
use windows::Win32::{
    Foundation::HANDLE,
    NetworkManagement::{
        IpHelper::{
            FreeMibTable, GetIfTable2, GetUnicastIpAddressTable, MIB_IF_ROW2, MIB_IF_TABLE2, MIB_NOTIFICATION_TYPE,
            MIB_UNICASTIPADDRESS_ROW, MIB_UNICASTIPADDRESS_TABLE, NotifyIpInterfaceChange,
            NotifyUnicastIpAddressChange,
        },
        Ndis::IfOperStatusUp,
    },
    Networking::WinSock::{AF_INET, IpDadStatePreferred, SOCKADDR_INET},
};

use crate::{
    config::Config,
    core::{
        diagnostics,
        manager::{CoreManager, RunningMode},
    },
    process::AsyncHandler,
};

const EVENT_DEBOUNCE: Duration = Duration::from_millis(1000);
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(5);
const LOOP_INTERVAL: Duration = Duration::from_millis(250);

static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);
static INTERFACE_GENERATION: AtomicU64 = AtomicU64::new(0);
static ADDRESS_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq)]
struct InterfaceRow {
    index: u32,
    alias: String,
    description: String,
    is_up: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AddressRow {
    interface_index: u32,
    address: Ipv4Addr,
    prefix_length: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct HotspotInterfaceSignature {
    index: u32,
    alias: String,
    ipv4_subnets: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
struct HotspotSignature {
    interfaces: Vec<HotspotInterfaceSignature>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Generations {
    interfaces: u64,
    addresses: u64,
}

impl Generations {
    fn load() -> Self {
        Self {
            interfaces: INTERFACE_GENERATION.load(Ordering::Acquire),
            addresses: ADDRESS_GENERATION.load(Ordering::Acquire),
        }
    }
}

unsafe extern "system" fn interface_change_callback(
    _context: *const c_void,
    _row: *const windows::Win32::NetworkManagement::IpHelper::MIB_IPINTERFACE_ROW,
    _notification_type: MIB_NOTIFICATION_TYPE,
) {
    INTERFACE_GENERATION.fetch_add(1, Ordering::AcqRel);
}

unsafe extern "system" fn address_change_callback(
    _context: *const c_void,
    _row: *const MIB_UNICASTIPADDRESS_ROW,
    _notification_type: MIB_NOTIFICATION_TYPE,
) {
    ADDRESS_GENERATION.fetch_add(1, Ordering::AcqRel);
}

fn utf16z(value: &[u16]) -> String {
    let len = value.iter().position(|item| *item == 0).unwrap_or(value.len());
    String::from_utf16_lossy(&value[..len])
}

fn ipv4_from_sockaddr(value: &SOCKADDR_INET) -> Option<Ipv4Addr> {
    let family = unsafe { value.si_family };
    if family != AF_INET {
        return None;
    }

    let raw = unsafe { value.Ipv4.sin_addr.S_un.S_addr };
    Some(Ipv4Addr::from(raw.to_ne_bytes()))
}

fn ipv4_cidr(address: Ipv4Addr, prefix_length: u8) -> Option<String> {
    if prefix_length > 32 {
        return None;
    }
    let mask = if prefix_length == 0 {
        0
    } else {
        u32::MAX << (32 - prefix_length)
    };
    let network = Ipv4Addr::from(u32::from(address) & mask);
    Some(format!("{network}/{prefix_length}"))
}

fn load_interfaces() -> Result<Vec<InterfaceRow>> {
    let mut table: *mut MIB_IF_TABLE2 = null_mut();
    let status = unsafe { GetIfTable2(&mut table) };
    if status.0 != 0 || table.is_null() {
        return Err(anyhow!("GetIfTable2 failed with Windows error {}", status.0));
    }

    let result = unsafe {
        let table_ref = &*table;
        let rows = slice::from_raw_parts(table_ref.Table.as_ptr(), table_ref.NumEntries as usize);
        rows.iter()
            .map(|row: &MIB_IF_ROW2| InterfaceRow {
                index: row.InterfaceIndex,
                alias: utf16z(&row.Alias),
                description: utf16z(&row.Description),
                is_up: row.OperStatus == IfOperStatusUp,
            })
            .collect::<Vec<_>>()
    };

    unsafe { FreeMibTable(table.cast::<c_void>()) };
    Ok(result)
}

fn load_addresses() -> Result<Vec<AddressRow>> {
    let mut table: *mut MIB_UNICASTIPADDRESS_TABLE = null_mut();
    let status = unsafe { GetUnicastIpAddressTable(AF_INET, &mut table) };
    if status.0 != 0 || table.is_null() {
        return Err(anyhow!(
            "GetUnicastIpAddressTable failed with Windows error {}",
            status.0
        ));
    }

    let result = unsafe {
        let table_ref = &*table;
        let rows = slice::from_raw_parts(table_ref.Table.as_ptr(), table_ref.NumEntries as usize);
        rows.iter()
            .filter(|row| row.DadState == IpDadStatePreferred)
            .filter_map(|row: &MIB_UNICASTIPADDRESS_ROW| {
                let address = ipv4_from_sockaddr(&row.Address)?;
                if address.is_unspecified() || address.is_loopback() || address.is_link_local() {
                    return None;
                }
                Some(AddressRow {
                    interface_index: row.InterfaceIndex,
                    address,
                    prefix_length: row.OnLinkPrefixLength,
                })
            })
            .collect::<Vec<_>>()
    };

    unsafe { FreeMibTable(table.cast::<c_void>()) };
    Ok(result)
}

fn interface_identity(interface: &InterfaceRow) -> String {
    format!("{} {}", interface.alias, interface.description).to_lowercase()
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

fn is_hotspot_base_adapter(interface: &InterfaceRow) -> bool {
    let identity = interface_identity(interface);
    if is_filter_component(&identity) {
        return false;
    }

    [
        "microsoft wi-fi direct virtual adapter",
        "microsoft wifi direct virtual adapter",
        "microsoft hosted network",
        "hosted network virtual",
        "mobile hotspot",
    ]
    .iter()
    .any(|marker| identity.contains(marker))
}

fn capture_hotspot_signature() -> Result<HotspotSignature> {
    let interfaces = load_interfaces()?;
    let addresses = load_addresses()?;
    let mut addresses_by_interface = BTreeMap::<u32, Vec<String>>::new();

    for address in addresses {
        if !address.address.is_private() || !(8..=30).contains(&address.prefix_length) {
            continue;
        }
        if let Some(cidr) = ipv4_cidr(address.address, address.prefix_length) {
            addresses_by_interface
                .entry(address.interface_index)
                .or_default()
                .push(cidr);
        }
    }

    let mut hotspot_interfaces = interfaces
        .into_iter()
        .filter(|interface| interface.is_up && is_hotspot_base_adapter(interface))
        .map(|interface| {
            let mut ipv4_subnets = addresses_by_interface.remove(&interface.index).unwrap_or_default();
            ipv4_subnets.sort();
            ipv4_subnets.dedup();
            HotspotInterfaceSignature {
                index: interface.index,
                alias: interface.alias,
                ipv4_subnets,
            }
        })
        .collect::<Vec<_>>();
    hotspot_interfaces.sort_by_key(|interface| interface.index);

    Ok(HotspotSignature {
        interfaces: hotspot_interfaces,
    })
}

fn register_notifications() -> [u32; 2] {
    let mut interface_handle = HANDLE::default();
    let mut address_handle = HANDLE::default();

    let interface_status = unsafe {
        NotifyIpInterfaceChange(
            AF_INET,
            Some(interface_change_callback),
            None,
            false,
            &mut interface_handle,
        )
    };
    let address_status = unsafe {
        NotifyUnicastIpAddressChange(AF_INET, Some(address_change_callback), None, false, &mut address_handle)
    };

    [interface_status.0, address_status.0]
}

async fn capture_signature() -> Result<HotspotSignature> {
    tokio::task::spawn_blocking(capture_hotspot_signature)
        .await
        .map_err(|error| anyhow!("Windows hotspot signature task failed: {error}"))?
}

async fn refresh_runtime_guards(previous: &HotspotSignature, current: &HotspotSignature) {
    let manager = CoreManager::global();
    if matches!(*manager.get_running_mode(), RunningMode::NotRunning) {
        diagnostics::info(
            "windows-hotspot-guard",
            "refresh-skipped-core-stopped",
            json!({"previous": previous, "current": current}),
        );
        return;
    }

    let tun_enabled = Config::verge().await.latest_arc().enable_tun_mode.unwrap_or(false);
    if !tun_enabled {
        diagnostics::info(
            "windows-hotspot-guard",
            "refresh-skipped-tun-disabled",
            json!({"previous": previous, "current": current}),
        );
        return;
    }

    diagnostics::info(
        "windows-hotspot-guard",
        "refresh-requested",
        json!({
            "previous": previous,
            "current": current,
            "strategy": "regenerate-authoritative-runtime-and-recompute-managed-guards",
            "physical_interface_pinned": false,
        }),
    );

    match manager.update_config_forced().await {
        Ok(outcome) => {
            let successful = outcome.is_valid();
            if successful {
                diagnostics::info(
                    "windows-hotspot-guard",
                    "refresh-succeeded",
                    json!({"outcome": outcome.to_string(), "current": current}),
                );
            } else {
                diagnostics::warn(
                    "windows-hotspot-guard",
                    "refresh-not-applied",
                    json!({"outcome": outcome.to_string(), "current": current}),
                );
            }
        }
        Err(error) => diagnostics::error(
            "windows-hotspot-guard",
            "refresh-failed",
            json!({"error": error.to_string(), "current": current}),
        ),
    }
}

async fn monitor_loop() {
    let registration = register_notifications();
    diagnostics::info(
        "windows-hotspot-guard",
        "monitor-started",
        json!({
            "notification_api": "IP Helper",
            "interface_registration_status": registration[0],
            "address_registration_status": registration[1],
            "event_debounce_ms": EVENT_DEBOUNCE.as_millis(),
            "watchdog_interval_ms": WATCHDOG_INTERVAL.as_millis(),
            "policy": "dynamic-hotspot-only; never pin physical upstream",
        }),
    );

    let mut previous = match capture_signature().await {
        Ok(signature) => signature,
        Err(error) => {
            diagnostics::warn(
                "windows-hotspot-guard",
                "baseline-failed",
                json!({"error": error.to_string()}),
            );
            HotspotSignature::default()
        }
    };
    diagnostics::info("windows-hotspot-guard", "baseline", json!({"signature": &previous}));

    let mut generations = Generations::load();
    let mut last_watchdog = Instant::now();
    let mut interval = tokio::time::interval(LOOP_INTERVAL);

    loop {
        interval.tick().await;
        let current_generations = Generations::load();
        let event_changed = current_generations != generations;
        let watchdog_due = last_watchdog.elapsed() >= WATCHDOG_INTERVAL;
        if !event_changed && !watchdog_due {
            continue;
        }

        if event_changed {
            tokio::time::sleep(EVENT_DEBOUNCE).await;
            generations = Generations::load();
        } else {
            generations = current_generations;
        }
        last_watchdog = Instant::now();

        let current = match capture_signature().await {
            Ok(signature) => signature,
            Err(error) => {
                diagnostics::warn(
                    "windows-hotspot-guard",
                    "snapshot-failed",
                    json!({"error": error.to_string()}),
                );
                continue;
            }
        };

        if current == previous {
            continue;
        }

        diagnostics::info(
            "windows-hotspot-guard",
            "hotspot-signature-changed",
            json!({"previous": &previous, "current": &current}),
        );
        refresh_runtime_guards(&previous, &current).await;
        previous = current;
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
    use super::{InterfaceRow, is_hotspot_base_adapter};

    fn interface(alias: &str, description: &str) -> InterfaceRow {
        InterfaceRow {
            index: 1,
            alias: alias.to_string(),
            description: description.to_string(),
            is_up: true,
        }
    }

    #[test]
    fn recognizes_real_wifi_direct_adapter() {
        assert!(is_hotspot_base_adapter(&interface(
            "本地连接* 10",
            "Microsoft Wi-Fi Direct Virtual Adapter #2",
        )));
    }

    #[test]
    fn ignores_wifi_direct_filter_components() {
        assert!(!is_hotspot_base_adapter(&interface(
            "本地连接* 10-WFP Native MAC Layer LightWeight Filter-0000",
            "Microsoft Wi-Fi Direct Virtual Adapter #2-WFP Native MAC Layer LightWeight Filter-0000",
        )));
        assert!(!is_hotspot_base_adapter(&interface(
            "本地连接* 10-QoS Packet Scheduler-0000",
            "Microsoft Wi-Fi Direct Virtual Adapter #2-QoS Packet Scheduler-0000",
        )));
    }

    #[test]
    fn physical_wifi_is_not_hotspot_adapter() {
        assert!(!is_hotspot_base_adapter(&interface("WLAN", "Intel(R) Wi-Fi 6 AX101",)));
    }
}
