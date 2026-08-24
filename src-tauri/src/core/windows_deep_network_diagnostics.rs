use std::{
    collections::BTreeMap,
    ffi::c_void,
    net::Ipv4Addr,
    ptr::null_mut,
    slice,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use anyhow::{Result, anyhow};
use serde::Serialize;
use serde_json::json;
use windows::Win32::{
    NetworkManagement::{
        IpHelper::{
            FreeMibTable, GetIfTable2, GetIpForwardTable2, GetIpInterfaceEntry, GetUnicastIpAddressTable, MIB_IF_ROW2,
            MIB_IF_TABLE2, MIB_IPFORWARD_ROW2, MIB_IPFORWARD_TABLE2, MIB_IPINTERFACE_ROW, MIB_UNICASTIPADDRESS_ROW,
            MIB_UNICASTIPADDRESS_TABLE,
        },
        Ndis::IfOperStatusUp,
    },
    Networking::WinSock::{AF_INET, IpDadStatePreferred, SOCKADDR_INET},
};

use crate::{core::diagnostics, process::AsyncHandler};

const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
const MAX_ROUTES: usize = 128;
const MAX_INTERFACES: usize = 64;
static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct AddressSnapshot {
    address: String,
    prefix_length: u8,
    skip_as_source: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct InterfaceSnapshot {
    index: u32,
    guid: String,
    alias: String,
    description: String,
    is_up: bool,
    mtu: u32,
    interface_type: u32,
    physical_medium_type: i32,
    metric: Option<u32>,
    connected: Option<bool>,
    forwarding_enabled: Option<bool>,
    weak_host_send: Option<bool>,
    weak_host_receive: Option<bool>,
    disable_default_routes: Option<bool>,
    ipv4: Vec<AddressSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct RouteSnapshot {
    destination: String,
    prefix_length: u8,
    next_hop: String,
    interface_index: u32,
    interface_alias: String,
    route_metric: u32,
    interface_metric: Option<u32>,
    effective_metric: Option<u32>,
    protocol: i32,
    origin: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct DeepNetworkSnapshot {
    interfaces: Vec<InterfaceSnapshot>,
    routes: Vec<RouteSnapshot>,
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

fn load_interfaces() -> Result<Vec<MIB_IF_ROW2>> {
    let mut table: *mut MIB_IF_TABLE2 = null_mut();
    let status = unsafe { GetIfTable2(&mut table) };
    if status.0 != 0 || table.is_null() {
        return Err(anyhow!("GetIfTable2 failed with Windows error {}", status.0));
    }
    let result = unsafe {
        let table_ref = &*table;
        slice::from_raw_parts(table_ref.Table.as_ptr(), table_ref.NumEntries as usize).to_vec()
    };
    unsafe { FreeMibTable(table.cast::<c_void>()) };
    Ok(result)
}

fn load_addresses() -> Result<Vec<MIB_UNICASTIPADDRESS_ROW>> {
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
        slice::from_raw_parts(table_ref.Table.as_ptr(), table_ref.NumEntries as usize).to_vec()
    };
    unsafe { FreeMibTable(table.cast::<c_void>()) };
    Ok(result)
}

fn load_routes() -> Result<Vec<MIB_IPFORWARD_ROW2>> {
    let mut table: *mut MIB_IPFORWARD_TABLE2 = null_mut();
    let status = unsafe { GetIpForwardTable2(AF_INET, &mut table) };
    if status.0 != 0 || table.is_null() {
        return Err(anyhow!("GetIpForwardTable2 failed with Windows error {}", status.0));
    }
    let result = unsafe {
        let table_ref = &*table;
        slice::from_raw_parts(table_ref.Table.as_ptr(), table_ref.NumEntries as usize).to_vec()
    };
    unsafe { FreeMibTable(table.cast::<c_void>()) };
    Ok(result)
}

fn interface_ip_state(interface_index: u32) -> Option<MIB_IPINTERFACE_ROW> {
    let mut row = MIB_IPINTERFACE_ROW {
        Family: AF_INET,
        InterfaceIndex: interface_index,
        ..Default::default()
    };
    let status = unsafe { GetIpInterfaceEntry(&mut row) };
    (status.0 == 0).then_some(row)
}

fn capture_snapshot() -> Result<DeepNetworkSnapshot> {
    let interfaces = load_interfaces()?;
    let addresses = load_addresses()?;
    let routes = load_routes()?;
    let alias_by_index = interfaces
        .iter()
        .map(|row| (row.InterfaceIndex, utf16z(&row.Alias)))
        .collect::<BTreeMap<_, _>>();

    let mut interface_snapshots = interfaces
        .iter()
        .filter(|row| {
            row.OperStatus == IfOperStatusUp
                || utf16z(&row.Alias).to_lowercase().contains("mihomo")
                || utf16z(&row.Description).to_lowercase().contains("wi-fi direct")
                || utf16z(&row.Description).to_lowercase().contains("wifi direct")
        })
        .map(|row| {
            let ip_state = interface_ip_state(row.InterfaceIndex);
            let mut ipv4 = addresses
                .iter()
                .filter(|address| {
                    address.InterfaceIndex == row.InterfaceIndex && address.DadState == IpDadStatePreferred
                })
                .filter_map(|address| {
                    let ip = ipv4_from_sockaddr(&address.Address)?;
                    Some(AddressSnapshot {
                        address: ip.to_string(),
                        prefix_length: address.OnLinkPrefixLength,
                        skip_as_source: address.SkipAsSource,
                    })
                })
                .collect::<Vec<_>>();
            ipv4.sort_by(|left, right| left.address.cmp(&right.address));
            InterfaceSnapshot {
                index: row.InterfaceIndex,
                guid: format!("{:?}", row.InterfaceGuid),
                alias: utf16z(&row.Alias),
                description: utf16z(&row.Description),
                is_up: row.OperStatus == IfOperStatusUp,
                mtu: row.Mtu,
                interface_type: row.Type,
                physical_medium_type: row.PhysicalMediumType.0,
                metric: ip_state.as_ref().map(|state| state.Metric),
                connected: ip_state.as_ref().map(|state| state.Connected),
                forwarding_enabled: ip_state.as_ref().map(|state| state.ForwardingEnabled),
                weak_host_send: ip_state.as_ref().map(|state| state.WeakHostSend),
                weak_host_receive: ip_state.as_ref().map(|state| state.WeakHostReceive),
                disable_default_routes: ip_state.as_ref().map(|state| state.DisableDefaultRoutes),
                ipv4,
            }
        })
        .collect::<Vec<_>>();
    interface_snapshots.sort_by_key(|row| row.index);
    interface_snapshots.truncate(MAX_INTERFACES);

    let mut route_snapshots = routes
        .iter()
        .filter_map(|row| {
            let destination = ipv4_from_sockaddr(&row.DestinationPrefix.Prefix)?;
            let next_hop = ipv4_from_sockaddr(&row.NextHop)?;
            let interface_metric = interface_ip_state(row.InterfaceIndex).map(|state| state.Metric);
            Some(RouteSnapshot {
                destination: destination.to_string(),
                prefix_length: row.DestinationPrefix.PrefixLength,
                next_hop: next_hop.to_string(),
                interface_index: row.InterfaceIndex,
                interface_alias: alias_by_index.get(&row.InterfaceIndex).cloned().unwrap_or_default(),
                route_metric: row.Metric,
                interface_metric,
                effective_metric: interface_metric.map(|metric| metric.saturating_add(row.Metric)),
                protocol: row.Protocol.0,
                origin: row.Origin.0,
            })
        })
        .collect::<Vec<_>>();
    route_snapshots.sort_by(|left, right| {
        (
            left.prefix_length,
            left.effective_metric.unwrap_or(u32::MAX),
            left.interface_index,
        )
            .cmp(&(
                right.prefix_length,
                right.effective_metric.unwrap_or(u32::MAX),
                right.interface_index,
            ))
    });
    route_snapshots.truncate(MAX_ROUTES);

    Ok(DeepNetworkSnapshot {
        interfaces: interface_snapshots,
        routes: route_snapshots,
    })
}

async fn capture() -> Result<DeepNetworkSnapshot> {
    tokio::task::spawn_blocking(capture_snapshot)
        .await
        .map_err(|error| anyhow!("deep Windows network diagnostic task failed: {error}"))?
}

async fn monitor_loop() {
    diagnostics::info(
        "windows-network-deep",
        "deep-monitor-started",
        json!({
            "sample_interval_ms": SAMPLE_INTERVAL.as_millis(),
            "captures": [
                "interface-guid",
                "forwarding-enabled",
                "weak-host-send",
                "weak-host-receive",
                "disable-default-routes",
                "interface-metric",
                "skip-as-source",
                "full-ipv4-route-table"
            ],
            "native_api_only": true,
        }),
    );

    let mut previous: Option<DeepNetworkSnapshot> = None;
    let mut interval = tokio::time::interval(SAMPLE_INTERVAL);
    loop {
        interval.tick().await;
        match capture().await {
            Ok(current) => {
                if previous.as_ref() == Some(&current) {
                    continue;
                }
                diagnostics::info(
                    "windows-network-deep",
                    if previous.is_none() {
                        "deep-baseline"
                    } else {
                        "deep-changed"
                    },
                    json!({
                        "previous": previous.as_ref(),
                        "current": &current,
                    }),
                );
                previous = Some(current);
            }
            Err(error) => diagnostics::warn(
                "windows-network-deep",
                "deep-snapshot-failed",
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
