use std::{
    collections::{BTreeMap, BTreeSet},
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
            FreeMibTable, GetIfTable2, GetIpForwardTable2, GetIpInterfaceEntry, GetUnicastIpAddressTable, MIB_IF_ROW2,
            MIB_IF_TABLE2, MIB_IPFORWARD_ROW2, MIB_IPFORWARD_TABLE2, MIB_IPINTERFACE_ROW, MIB_NOTIFICATION_TYPE,
            MIB_UNICASTIPADDRESS_ROW, MIB_UNICASTIPADDRESS_TABLE, NotifyIpInterfaceChange, NotifyRouteChange2,
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

const EVENT_DEBOUNCE: Duration = Duration::from_millis(750);
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(10);
const LOOP_INTERVAL: Duration = Duration::from_millis(250);
const GUARD_CONFIRM_SAMPLES: usize = 3;
const GUARD_CONFIRM_DELAY: Duration = Duration::from_millis(500);
const MAX_INTERFACES: usize = 48;

static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);
static INTERFACE_GENERATION: AtomicU64 = AtomicU64::new(0);
static ADDRESS_GENERATION: AtomicU64 = AtomicU64::new(0);
static ROUTE_GENERATION: AtomicU64 = AtomicU64::new(0);

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
struct InterfaceSnapshot {
    index: u32,
    alias: String,
    description: String,
    is_up: bool,
    is_hotspot_side: bool,
    is_virtual_or_tunnel: bool,
    ipv4: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct DefaultRouteSnapshot {
    interface_index: u32,
    interface_alias: String,
    gateway: String,
    route_metric: u32,
    interface_metric: Option<u32>,
    effective_metric: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct PhysicalUpstreamSnapshot {
    interface_index: u32,
    interface_alias: String,
    source_address: String,
    gateway: String,
    route_metric: u32,
    interface_metric: u32,
    effective_metric: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct WindowsTopologySnapshot {
    interfaces: Vec<InterfaceSnapshot>,
    default_routes: Vec<DefaultRouteSnapshot>,
    hotspot_present: bool,
    hotspot_subnets: Vec<String>,
    physical_upstream: Option<PhysicalUpstreamSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct HotspotGuardSignature {
    present: bool,
    interfaces: Vec<String>,
    subnets: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Generations {
    interfaces: u64,
    addresses: u64,
    routes: u64,
}

impl Generations {
    fn load() -> Self {
        Self {
            interfaces: INTERFACE_GENERATION.load(Ordering::Acquire),
            addresses: ADDRESS_GENERATION.load(Ordering::Acquire),
            routes: ROUTE_GENERATION.load(Ordering::Acquire),
        }
    }

    const fn delta(self, previous: Self) -> Self {
        Self {
            interfaces: self.interfaces.saturating_sub(previous.interfaces),
            addresses: self.addresses.saturating_sub(previous.addresses),
            routes: self.routes.saturating_sub(previous.routes),
        }
    }
}

unsafe extern "system" fn interface_change_callback(
    _context: *const c_void,
    _row: *const MIB_IPINTERFACE_ROW,
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

unsafe extern "system" fn route_change_callback(
    _context: *const c_void,
    _row: *const MIB_IPFORWARD_ROW2,
    _notification_type: MIB_NOTIFICATION_TYPE,
) {
    ROUTE_GENERATION.fetch_add(1, Ordering::AcqRel);
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

fn load_default_routes() -> Result<Vec<MIB_IPFORWARD_ROW2>> {
    let mut table: *mut MIB_IPFORWARD_TABLE2 = null_mut();
    let status = unsafe { GetIpForwardTable2(AF_INET, &mut table) };
    if status.0 != 0 || table.is_null() {
        return Err(anyhow!("GetIpForwardTable2 failed with Windows error {}", status.0));
    }

    let result = unsafe {
        let table_ref = &*table;
        let rows = slice::from_raw_parts(table_ref.Table.as_ptr(), table_ref.NumEntries as usize);
        rows.iter()
            .filter(|row| {
                row.DestinationPrefix.PrefixLength == 0
                    && ipv4_from_sockaddr(&row.DestinationPrefix.Prefix).is_some_and(|address| address.is_unspecified())
                    && ipv4_from_sockaddr(&row.NextHop).is_some_and(|address| !address.is_unspecified())
            })
            .copied()
            .collect::<Vec<_>>()
    };

    unsafe { FreeMibTable(table.cast::<c_void>()) };
    Ok(result)
}

fn interface_metric(interface_index: u32) -> Option<u32> {
    let mut row = MIB_IPINTERFACE_ROW {
        Family: AF_INET,
        InterfaceIndex: interface_index,
        ..Default::default()
    };
    let status = unsafe { GetIpInterfaceEntry(&mut row) };
    (status.0 == 0 && row.Connected && !row.DisableDefaultRoutes).then_some(row.Metric)
}

fn identity(interface: &InterfaceRow) -> String {
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

fn is_hotspot_side(interface: &InterfaceRow) -> bool {
    let identity = identity(interface);
    if is_filter_component(&identity) {
        return false;
    }

    [
        "wi-fi direct virtual adapter",
        "wifi direct virtual adapter",
        "microsoft hosted network",
        "hosted network virtual",
        "mobile hotspot",
    ]
    .iter()
    .any(|marker| identity.contains(marker))
}

fn is_virtual_or_tunnel(interface: &InterfaceRow) -> bool {
    if is_hotspot_side(interface) {
        return true;
    }

    let identity = identity(interface);
    [
        "mihomo",
        "clash",
        "hyper-v",
        "vmware",
        "virtualbox",
        "wintun",
        "wireguard",
        "tailscale",
        "zerotier",
        "tap-windows",
        "openvpn tap",
    ]
    .iter()
    .any(|marker| identity.contains(marker))
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

fn capture_topology() -> Result<WindowsTopologySnapshot> {
    let interfaces = load_interfaces()?;
    let addresses = load_addresses()?;
    let routes = load_default_routes()?;
    let interface_map = interfaces
        .iter()
        .map(|interface| (interface.index, interface))
        .collect::<BTreeMap<_, _>>();
    let default_route_indices = routes.iter().map(|route| route.InterfaceIndex).collect::<BTreeSet<_>>();

    let mut interface_snapshots = interfaces
        .iter()
        .filter(|interface| {
            interface.is_up
                || is_hotspot_side(interface)
                || default_route_indices.contains(&interface.index)
                || identity(interface).contains("mihomo")
        })
        .map(|interface| {
            let mut ipv4 = addresses
                .iter()
                .filter(|address| address.interface_index == interface.index)
                .map(|address| format!("{}/{}", address.address, address.prefix_length))
                .collect::<Vec<_>>();
            ipv4.sort();
            InterfaceSnapshot {
                index: interface.index,
                alias: interface.alias.clone(),
                description: interface.description.clone(),
                is_up: interface.is_up,
                is_hotspot_side: is_hotspot_side(interface),
                is_virtual_or_tunnel: is_virtual_or_tunnel(interface),
                ipv4,
            }
        })
        .collect::<Vec<_>>();
    interface_snapshots.sort_by_key(|interface| interface.index);
    interface_snapshots.truncate(MAX_INTERFACES);

    let mut default_routes = routes
        .iter()
        .filter_map(|route| {
            let interface = interface_map.get(&route.InterfaceIndex)?;
            let gateway = ipv4_from_sockaddr(&route.NextHop)?;
            let metric = interface_metric(route.InterfaceIndex);
            Some(DefaultRouteSnapshot {
                interface_index: route.InterfaceIndex,
                interface_alias: interface.alias.clone(),
                gateway: gateway.to_string(),
                route_metric: route.Metric,
                interface_metric: metric,
                effective_metric: metric.map(|metric| metric.saturating_add(route.Metric)),
            })
        })
        .collect::<Vec<_>>();
    default_routes.sort_by_key(|route| {
        (
            route.effective_metric.unwrap_or(u32::MAX),
            route.route_metric,
            route.interface_index,
        )
    });

    let mut hotspot_present = false;
    let mut hotspot_subnets = BTreeSet::new();
    for interface in interfaces
        .iter()
        .filter(|interface| interface.is_up && is_hotspot_side(interface))
    {
        hotspot_present = true;
        for address in addresses
            .iter()
            .filter(|address| address.interface_index == interface.index && address.address.is_private())
        {
            if (8..=30).contains(&address.prefix_length)
                && let Some(cidr) = ipv4_cidr(address.address, address.prefix_length)
            {
                hotspot_subnets.insert(cidr);
            }
        }
    }

    let physical_upstream = routes
        .iter()
        .filter_map(|route| {
            let interface = interface_map.get(&route.InterfaceIndex)?;
            if !interface.is_up || is_virtual_or_tunnel(interface) {
                return None;
            }
            let source = addresses
                .iter()
                .filter(|address| address.interface_index == interface.index)
                .min_by_key(|address| u32::from(address.address))?;
            let gateway = ipv4_from_sockaddr(&route.NextHop)?;
            let interface_metric = interface_metric(interface.index)?;
            Some(PhysicalUpstreamSnapshot {
                interface_index: interface.index,
                interface_alias: interface.alias.clone(),
                source_address: source.address.to_string(),
                gateway: gateway.to_string(),
                route_metric: route.Metric,
                interface_metric,
                effective_metric: route.Metric.saturating_add(interface_metric),
            })
        })
        .min_by_key(|route| {
            (
                route.effective_metric,
                route.route_metric,
                route.interface_metric,
                route.interface_index,
            )
        });

    Ok(WindowsTopologySnapshot {
        interfaces: interface_snapshots,
        default_routes,
        hotspot_present,
        hotspot_subnets: hotspot_subnets.into_iter().collect(),
        physical_upstream,
    })
}

fn register_notifications() -> [u32; 3] {
    let mut interface_handle = HANDLE::default();
    let mut address_handle = HANDLE::default();
    let mut route_handle = HANDLE::default();

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
    let route_status = unsafe {
        NotifyRouteChange2(
            AF_INET,
            Some(route_change_callback),
            std::ptr::null(),
            false,
            &mut route_handle,
        )
    };

    [interface_status.0, address_status.0, route_status.0]
}

async fn capture_snapshot() -> Result<WindowsTopologySnapshot> {
    tokio::task::spawn_blocking(capture_topology)
        .await
        .map_err(|error| anyhow!("Windows topology task failed: {error}"))?
}

fn hotspot_guard_signature(snapshot: &WindowsTopologySnapshot) -> Option<HotspotGuardSignature> {
    if !snapshot.hotspot_present {
        return Some(HotspotGuardSignature {
            present: false,
            interfaces: Vec::new(),
            subnets: Vec::new(),
        });
    }

    if snapshot.hotspot_subnets.is_empty() {
        // Adapter Up is not the same as an ICS-ready hotspot. Windows commonly
        // raises interface notifications before the private IPv4 address exists.
        return None;
    }

    let mut interfaces = snapshot
        .interfaces
        .iter()
        .filter(|interface| interface.is_up && interface.is_hotspot_side)
        .map(|interface| interface.alias.clone())
        .filter(|alias| !alias.trim().is_empty())
        .collect::<Vec<_>>();
    interfaces.sort();
    interfaces.dedup();

    Some(HotspotGuardSignature {
        present: true,
        interfaces,
        subnets: snapshot.hotspot_subnets.clone(),
    })
}

async fn confirm_guard_signature(expected: &HotspotGuardSignature) -> Result<Option<WindowsTopologySnapshot>> {
    let mut latest = None;
    for sample in 0..GUARD_CONFIRM_SAMPLES {
        if sample > 0 {
            tokio::time::sleep(GUARD_CONFIRM_DELAY).await;
        }

        let snapshot = capture_snapshot().await?;
        if hotspot_guard_signature(&snapshot).as_ref() != Some(expected) {
            return Ok(None);
        }
        latest = Some(snapshot);
    }
    Ok(latest)
}

async fn refresh_runtime_network_state(
    reason: &'static str,
    previous: &WindowsTopologySnapshot,
    current: &WindowsTopologySnapshot,
) -> bool {
    let manager = CoreManager::global();
    if matches!(*manager.get_running_mode(), RunningMode::NotRunning) {
        diagnostics::info(
            "windows-hotspot-guard",
            "refresh-skipped-core-stopped",
            json!({
                "reason": reason,
                "previous_hotspot_present": previous.hotspot_present,
                "current_hotspot_present": current.hotspot_present,
                "previous_hotspot_subnets": &previous.hotspot_subnets,
                "current_hotspot_subnets": &current.hotspot_subnets,
                "previous_physical_upstream": &previous.physical_upstream,
                "current_physical_upstream": &current.physical_upstream,
            }),
        );
        return true;
    }

    if !Config::verge().await.latest_arc().enable_tun_mode.unwrap_or(false) {
        diagnostics::info(
            "windows-hotspot-guard",
            "refresh-skipped-tun-disabled",
            json!({"reason": reason}),
        );
        return true;
    }

    diagnostics::info(
        "windows-hotspot-guard",
        "refresh-requested",
        json!({
            "reason": reason,
            "previous_hotspot_present": previous.hotspot_present,
            "current_hotspot_present": current.hotspot_present,
            "previous_hotspot_subnets": &previous.hotspot_subnets,
            "current_hotspot_subnets": &current.hotspot_subnets,
            "previous_physical_upstream": &previous.physical_upstream,
            "current_physical_upstream": &current.physical_upstream,
            "strategy": "stable-hotspot-state+runtime-managed-physical-interface-lease",
            "physical_interface_pinned": true,
            "physical_interface_pin_source": "runtime-managed-stable-physical-upstream",
            "physical_interface_pin_scope": "all-mihomo-outbound",
            "mihomo_auto_detect_interface": false,
            "proxy_socket_binding": "per-node/provider-defense-in-depth",
        }),
    );

    match manager.update_config_forced().await {
        Ok(outcome) if outcome.is_valid() => {
            diagnostics::info(
                "windows-hotspot-guard",
                "refresh-succeeded",
                json!({
                    "reason": reason,
                    "outcome": outcome.to_string(),
                    "requested_physical_upstream": &current.physical_upstream,
                }),
            );
            true
        }
        Ok(outcome) => {
            diagnostics::warn(
                "windows-hotspot-guard",
                "refresh-not-applied",
                json!({"reason": reason, "outcome": outcome.to_string()}),
            );
            false
        }
        Err(error) => {
            diagnostics::error(
                "windows-hotspot-guard",
                "refresh-failed",
                json!({"reason": reason, "error": error.to_string()}),
            );
            false
        }
    }
}

async fn monitor_loop() {
    let registration = register_notifications();
    diagnostics::info(
        "windows-network",
        "topology-monitor-started",
        json!({
            "notification_api": "IP Helper",
            "interface_registration_status": registration[0],
            "address_registration_status": registration[1],
            "route_registration_status": registration[2],
            "event_debounce_ms": EVENT_DEBOUNCE.as_millis(),
            "watchdog_interval_ms": WATCHDOG_INTERVAL.as_millis(),
            "runtime_hotspot_guard": true,
            "hotspot_ready_requires_private_subnet": true,
            "guard_confirm_samples": GUARD_CONFIRM_SAMPLES,
            "guard_confirm_delay_ms": GUARD_CONFIRM_DELAY.as_millis(),
            "managed_proxy_interface_binding": true,
            "runtime_managed_physical_interface_lease": true,
            "physical_interface_pin_scope": "all-mihomo-outbound",
            "mihomo_auto_detect_interface": false,
            "failover_strategy": "regenerate-runtime-on-physical-upstream-change",
        }),
    );

    let mut previous = match capture_snapshot().await {
        Ok(snapshot) => {
            diagnostics::info("windows-network", "topology-baseline", json!({"snapshot": &snapshot}));
            snapshot
        }
        Err(error) => {
            diagnostics::error(
                "windows-network",
                "topology-baseline-failed",
                json!({"error": error.to_string()}),
            );
            WindowsTopologySnapshot {
                interfaces: Vec::new(),
                default_routes: Vec::new(),
                hotspot_present: false,
                hotspot_subnets: Vec::new(),
                physical_upstream: None,
            }
        }
    };
    let mut last_applied_guard = hotspot_guard_signature(&previous);

    let mut generations = Generations::load();
    let mut last_watchdog = Instant::now();
    let mut interval = tokio::time::interval(LOOP_INTERVAL);

    loop {
        interval.tick().await;
        let baseline_generations = generations;
        let current_generations = Generations::load();
        let event_changed = current_generations != baseline_generations;
        let watchdog_due = last_watchdog.elapsed() >= WATCHDOG_INTERVAL;
        if !event_changed && !watchdog_due {
            continue;
        }

        let settled_generations = if event_changed {
            tokio::time::sleep(EVENT_DEBOUNCE).await;
            Generations::load()
        } else {
            current_generations
        };
        let delta = settled_generations.delta(baseline_generations);
        generations = settled_generations;
        last_watchdog = Instant::now();

        let current = match capture_snapshot().await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                diagnostics::warn(
                    "windows-network",
                    "topology-snapshot-failed",
                    json!({
                        "error": error.to_string(),
                        "notifications": {
                            "interface": delta.interfaces,
                            "address": delta.addresses,
                            "route": delta.routes,
                        }
                    }),
                );
                continue;
            }
        };

        if current == previous {
            continue;
        }

        let current_guard = hotspot_guard_signature(&current);
        let hotspot_changed = current.hotspot_present != previous.hotspot_present
            || current.hotspot_subnets != previous.hotspot_subnets
            || current_guard != hotspot_guard_signature(&previous);
        let default_routes_changed = current.default_routes != previous.default_routes;
        let physical_upstream_changed = current.physical_upstream != previous.physical_upstream;

        diagnostics::info(
            "windows-network",
            "topology-changed",
            json!({
                "notifications": {
                    "interface": delta.interfaces,
                    "address": delta.addresses,
                    "route": delta.routes,
                    "watchdog_only": !event_changed,
                },
                "hotspot_changed": hotspot_changed,
                "default_routes_changed": default_routes_changed,
                "physical_upstream_changed": physical_upstream_changed,
                "previous_hotspot_present": previous.hotspot_present,
                "current_hotspot_present": current.hotspot_present,
                "previous_hotspot_subnets": &previous.hotspot_subnets,
                "current_hotspot_subnets": &current.hotspot_subnets,
                "previous_physical_upstream": &previous.physical_upstream,
                "current_physical_upstream": &current.physical_upstream,
                "hotspot_guard_ready": current_guard.is_some(),
                "runtime_managed_physical_interface_lease": true,
                "snapshot": &current,
            }),
        );

        if current.hotspot_present && current_guard.is_none() {
            diagnostics::info(
                "windows-hotspot-guard",
                "refresh-deferred-hotspot-starting",
                json!({
                    "reason": "hotspot-adapter-up-without-private-subnet",
                    "current_hotspot_subnets": &current.hotspot_subnets,
                    "current_physical_upstream": &current.physical_upstream,
                    "strategy": "wait-for-ics-private-address-before-any-topology-reload",
                }),
            );
            previous = current;
            continue;
        }

        if let Some(signature) = current_guard.clone()
            && last_applied_guard.as_ref() != Some(&signature)
        {
            match confirm_guard_signature(&signature).await {
                Ok(Some(confirmed)) => {
                    diagnostics::info(
                        "windows-hotspot-guard",
                        "guard-state-confirmed",
                        json!({
                            "signature": &signature,
                            "samples": GUARD_CONFIRM_SAMPLES,
                            "confirmed_physical_upstream": &confirmed.physical_upstream,
                        }),
                    );
                    if refresh_runtime_network_state("hotspot-guard-state-changed", &previous, &confirmed).await {
                        last_applied_guard = Some(signature);
                    }
                }
                Ok(None) => {
                    diagnostics::info(
                        "windows-hotspot-guard",
                        "refresh-deferred-topology-still-settling",
                        json!({
                            "expected_signature": &signature,
                            "samples": GUARD_CONFIRM_SAMPLES,
                        }),
                    );
                }
                Err(error) => {
                    diagnostics::warn(
                        "windows-hotspot-guard",
                        "guard-confirmation-failed",
                        json!({"error": error.to_string()}),
                    );
                }
            }
        } else if physical_upstream_changed {
            // All Mihomo outbound is leased to the stable physical NIC. A real upstream
            // change must regenerate Runtime so the managed top-level lease follows it.
            refresh_runtime_network_state("physical-upstream-changed", &previous, &current).await;
        }

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
    use super::{
        AddressRow, HotspotGuardSignature, InterfaceRow, InterfaceSnapshot, WindowsTopologySnapshot,
        hotspot_guard_signature, is_hotspot_side,
    };
    use std::net::Ipv4Addr;

    fn interface(index: u32, alias: &str, description: &str, is_up: bool) -> InterfaceRow {
        InterfaceRow {
            index,
            alias: alias.to_string(),
            description: description.to_string(),
            is_up,
        }
    }

    fn capture_hotspot_test_state(interfaces: &[InterfaceRow], addresses: &[AddressRow]) -> (bool, Vec<String>) {
        let mut present = false;
        let mut subnets = std::collections::BTreeSet::new();
        for interface in interfaces
            .iter()
            .filter(|interface| interface.is_up && is_hotspot_side(interface))
        {
            present = true;
            for address in addresses
                .iter()
                .filter(|address| address.interface_index == interface.index && address.address.is_private())
            {
                if (8..=30).contains(&address.prefix_length)
                    && let Some(cidr) = super::ipv4_cidr(address.address, address.prefix_length)
                {
                    subnets.insert(cidr);
                }
            }
        }
        (present, subnets.into_iter().collect())
    }

    fn snapshot(hotspot_present: bool, hotspot_subnets: Vec<&str>, interface_up: bool) -> WindowsTopologySnapshot {
        WindowsTopologySnapshot {
            interfaces: vec![InterfaceSnapshot {
                index: 27,
                alias: "Local Area Connection* 10".into(),
                description: "Microsoft Wi-Fi Direct Virtual Adapter #2".into(),
                is_up: interface_up,
                is_hotspot_side: true,
                is_virtual_or_tunnel: true,
                ipv4: Vec::new(),
            }],
            default_routes: Vec::new(),
            hotspot_present,
            hotspot_subnets: hotspot_subnets.into_iter().map(str::to_string).collect(),
            physical_upstream: None,
        }
    }

    #[test]
    fn recognizes_windows_hotspot_base_adapter() {
        let adapter = interface(
            27,
            "Local Area Connection* 10",
            "Microsoft Wi-Fi Direct Virtual Adapter #2",
            true,
        );
        assert!(is_hotspot_side(&adapter));
    }

    #[test]
    fn ignores_wifi_direct_filter_components() {
        let filter = interface(
            33,
            "Local Area Connection* 10-WFP Native MAC Layer LightWeight Filter-0000",
            "Microsoft Wi-Fi Direct Virtual Adapter #2-WFP Native MAC Layer LightWeight Filter-0000",
            true,
        );
        assert!(!is_hotspot_side(&filter));
    }

    #[test]
    fn physical_wifi_is_not_classified_as_hotspot() {
        let adapter = interface(25, "WLAN", "Intel(R) Wi-Fi 6 AX101", true);
        assert!(!is_hotspot_side(&adapter));
    }

    #[test]
    fn hotspot_subnets_do_not_short_circuit_on_first_active_adapter() {
        let interfaces = [
            interface(
                7,
                "Local Area Connection* 9",
                "Microsoft Wi-Fi Direct Virtual Adapter",
                true,
            ),
            interface(
                27,
                "Local Area Connection* 10",
                "Microsoft Wi-Fi Direct Virtual Adapter #2",
                true,
            ),
        ];
        let addresses = [AddressRow {
            interface_index: 27,
            address: Ipv4Addr::new(172, 22, 44, 1),
            prefix_length: 24,
        }];
        let (present, subnets) = capture_hotspot_test_state(&interfaces, &addresses);
        assert!(present);
        assert_eq!(subnets, vec!["172.22.44.0/24"]);
    }

    #[test]
    fn hotspot_guard_waits_for_ics_private_address() {
        assert_eq!(hotspot_guard_signature(&snapshot(true, vec![], true)), None);
    }

    #[test]
    fn hotspot_guard_ready_state_contains_runtime_interface_and_subnet() {
        assert_eq!(
            hotspot_guard_signature(&snapshot(true, vec!["172.22.44.0/24"], true,)),
            Some(HotspotGuardSignature {
                present: true,
                interfaces: vec!["Local Area Connection* 10".into()],
                subnets: vec!["172.22.44.0/24".into()],
            })
        );
    }

    #[test]
    fn hotspot_guard_off_state_is_actionable_for_cleanup() {
        assert_eq!(
            hotspot_guard_signature(&snapshot(false, vec![], false)),
            Some(HotspotGuardSignature {
                present: false,
                interfaces: Vec::new(),
                subnets: Vec::new(),
            })
        );
    }
}
