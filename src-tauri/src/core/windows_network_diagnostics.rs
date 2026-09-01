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
const UPSTREAM_CONFIRM_SAMPLES: usize = 3;
const UPSTREAM_CONFIRM_DELAY: Duration = Duration::from_millis(500);
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
    forwarding_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct PhysicalUpstreamIdentity {
    interface_index: u32,
    interface_alias: String,
    source_address: String,
    gateway: String,
    forwarding_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct WindowsTopologySnapshot {
    interfaces: Vec<InterfaceSnapshot>,
    default_routes: Vec<DefaultRouteSnapshot>,
    hotspot_present: bool,
    hotspot_subnets: Vec<String>,
    physical_upstream: Option<PhysicalUpstreamSnapshot>,
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

fn interface_state(interface_index: u32) -> Option<(u32, bool)> {
    let mut row = MIB_IPINTERFACE_ROW {
        Family: AF_INET,
        InterfaceIndex: interface_index,
        ..Default::default()
    };
    let status = unsafe { GetIpInterfaceEntry(&mut row) };
    (status.0 == 0 && row.Connected && !row.DisableDefaultRoutes).then_some((row.Metric, row.ForwardingEnabled))
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
            let metric = interface_state(route.InterfaceIndex).map(|state| state.0);
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
            let (interface_metric, forwarding_enabled) = interface_state(interface.index)?;
            Some(PhysicalUpstreamSnapshot {
                interface_index: interface.index,
                interface_alias: interface.alias.clone(),
                source_address: source.address.to_string(),
                gateway: gateway.to_string(),
                route_metric: route.Metric,
                interface_metric,
                effective_metric: route.Metric.saturating_add(interface_metric),
                forwarding_enabled,
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

fn physical_upstream_identity(snapshot: &WindowsTopologySnapshot) -> Option<PhysicalUpstreamIdentity> {
    snapshot
        .physical_upstream
        .as_ref()
        .map(|upstream| PhysicalUpstreamIdentity {
            interface_index: upstream.interface_index,
            interface_alias: upstream.interface_alias.clone(),
            source_address: upstream.source_address.clone(),
            gateway: upstream.gateway.clone(),
            forwarding_enabled: upstream.forwarding_enabled,
        })
}

fn forwarding_state_changed(
    previous: Option<&PhysicalUpstreamIdentity>,
    current: Option<&PhysicalUpstreamIdentity>,
) -> bool {
    match (previous, current) {
        (Some(previous), Some(current)) => {
            previous.interface_index == current.interface_index
                && previous.interface_alias == current.interface_alias
                && previous.source_address == current.source_address
                && previous.gateway == current.gateway
                && previous.forwarding_enabled != current.forwarding_enabled
        }
        _ => false,
    }
}

fn hotspot_topology_changed(previous: &WindowsTopologySnapshot, current: &WindowsTopologySnapshot) -> bool {
    previous.hotspot_present != current.hotspot_present || previous.hotspot_subnets != current.hotspot_subnets
}

async fn confirm_physical_upstream(expected: &PhysicalUpstreamIdentity) -> Result<Option<WindowsTopologySnapshot>> {
    let mut latest = None;
    for sample in 0..UPSTREAM_CONFIRM_SAMPLES {
        if sample > 0 {
            tokio::time::sleep(UPSTREAM_CONFIRM_DELAY).await;
        }

        let snapshot = capture_snapshot().await?;
        if physical_upstream_identity(&snapshot).as_ref() != Some(expected) {
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
            "windows-network-upstream",
            "refresh-skipped-core-stopped",
            json!({
                "reason": reason,
                "previous_physical_upstream": &previous.physical_upstream,
                "current_physical_upstream": &current.physical_upstream,
            }),
        );
        return true;
    }

    if !Config::verge().await.latest_arc().enable_tun_mode.unwrap_or(false) {
        diagnostics::info(
            "windows-network-upstream",
            "refresh-skipped-tun-disabled",
            json!({"reason": reason}),
        );
        return true;
    }

    diagnostics::info(
        "windows-network-upstream",
        "refresh-requested",
        json!({
            "reason": reason,
            "previous_physical_upstream": &previous.physical_upstream,
            "current_physical_upstream": &current.physical_upstream,
            "trigger_scope": "stable-physical-upstream-or-forwarding-mode",
            "hotspot_events_can_trigger_core_refresh": "forwarding-mode-only",
            "hotspot_owner": "windows-hotspot-winrt",
            "proxy_socket_binding": "per-node/provider-defense-in-depth",
        }),
    );

    match manager.update_config_forced().await {
        Ok(outcome) if outcome.is_valid() => {
            diagnostics::info(
                "windows-network-upstream",
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
                "windows-network-upstream",
                "refresh-not-applied",
                json!({"reason": reason, "outcome": outcome.to_string()}),
            );
            false
        }
        Err(error) => {
            diagnostics::error(
                "windows-network-upstream",
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
            "hotspot_mode": "lifecycle-observability+routing-mode",
            "hotspot_owner": "windows-hotspot-winrt",
            "hotspot_events_can_trigger_core_refresh": "forwarding-mode-only",
            "physical_upstream_refresh": true,
            "physical_upstream_identity_ignores_metrics": true,
            "upstream_confirm_samples": UPSTREAM_CONFIRM_SAMPLES,
            "upstream_confirm_delay_ms": UPSTREAM_CONFIRM_DELAY.as_millis(),
            "failover_strategy": "confirm-stable-physical-upstream-or-forwarding-mode-then-regenerate-runtime",
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
    let mut last_runtime_upstream = physical_upstream_identity(&previous);

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

        let current_upstream = physical_upstream_identity(&current);
        let forwarding_mode_changed =
            forwarding_state_changed(last_runtime_upstream.as_ref(), current_upstream.as_ref());
        let runtime_upstream_changed = current_upstream.is_some() && current_upstream != last_runtime_upstream;
        let topology_changed = current != previous;
        if !topology_changed && !runtime_upstream_changed {
            continue;
        }

        let hotspot_changed = hotspot_topology_changed(&previous, &current);
        let default_routes_changed = current.default_routes != previous.default_routes;
        let snapshot_upstream_changed = physical_upstream_identity(&current) != physical_upstream_identity(&previous);

        if topology_changed {
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
                    "physical_upstream_identity_changed": snapshot_upstream_changed,
                    "runtime_upstream_change_pending": runtime_upstream_changed,
                    "previous_hotspot_present": previous.hotspot_present,
                    "current_hotspot_present": current.hotspot_present,
                    "previous_hotspot_subnets": &previous.hotspot_subnets,
                    "current_hotspot_subnets": &current.hotspot_subnets,
                    "previous_physical_upstream": &previous.physical_upstream,
                    "current_physical_upstream": &current.physical_upstream,
                    "hotspot_owner": "windows-hotspot-winrt",
                    "hotspot_events_can_trigger_core_refresh": "forwarding-mode-only",
                    "snapshot": &current,
                }),
            );
        }

        if hotspot_changed {
            diagnostics::info(
                "windows-hotspot-guard",
                "hotspot-observed-routing-mode-evaluation",
                json!({
                    "previous_hotspot_present": previous.hotspot_present,
                    "current_hotspot_present": current.hotspot_present,
                    "previous_hotspot_subnets": &previous.hotspot_subnets,
                    "current_hotspot_subnets": &current.hotspot_subnets,
                    "single_owner": true,
                    "owner": "windows-hotspot-winrt",
                    "forwarding_mode_changed": forwarding_mode_changed,
                    "lifecycle_mutation": false,
                    "core_refresh_policy": "only-for-stable-physical-forwarding-mode-change",
                }),
            );
        }

        if runtime_upstream_changed {
            if hotspot_changed && !forwarding_mode_changed {
                diagnostics::info(
                    "windows-network-upstream",
                    "refresh-deferred-during-hotspot-transition",
                    json!({
                        "candidate": &current_upstream,
                        "last_runtime_upstream": &last_runtime_upstream,
                        "retry": "next-ip-helper-event-or-watchdog",
                    }),
                );
            } else if let Some(candidate) = current_upstream.as_ref() {
                match confirm_physical_upstream(candidate).await {
                    Ok(Some(confirmed)) => {
                        let confirmed_identity = physical_upstream_identity(&confirmed);
                        let reason = if forwarding_mode_changed {
                            "physical-forwarding-mode-changed"
                        } else {
                            "physical-upstream-changed"
                        };
                        if confirmed_identity != last_runtime_upstream
                            && refresh_runtime_network_state(reason, &previous, &confirmed).await
                        {
                            last_runtime_upstream = confirmed_identity;
                        }
                    }
                    Ok(None) => {
                        diagnostics::info(
                            "windows-network-upstream",
                            "refresh-deferred-upstream-still-settling",
                            json!({
                                "expected": candidate,
                                "samples": UPSTREAM_CONFIRM_SAMPLES,
                            }),
                        );
                    }
                    Err(error) => {
                        diagnostics::warn(
                            "windows-network-upstream",
                            "upstream-confirmation-failed",
                            json!({"error": error.to_string()}),
                        );
                    }
                }
            }
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
        AddressRow, InterfaceRow, InterfaceSnapshot, PhysicalUpstreamSnapshot, WindowsTopologySnapshot,
        forwarding_state_changed, hotspot_topology_changed, is_hotspot_side, physical_upstream_identity,
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

    fn upstream(index: u32, alias: &str, source: &str, gateway: &str, route_metric: u32) -> PhysicalUpstreamSnapshot {
        PhysicalUpstreamSnapshot {
            interface_index: index,
            interface_alias: alias.into(),
            source_address: source.into(),
            gateway: gateway.into(),
            route_metric,
            interface_metric: 25,
            effective_metric: route_metric.saturating_add(25),
            forwarding_enabled: false,
        }
    }

    fn snapshot(
        hotspot_present: bool,
        hotspot_subnets: Vec<&str>,
        interface_up: bool,
        physical_upstream: Option<PhysicalUpstreamSnapshot>,
    ) -> WindowsTopologySnapshot {
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
            physical_upstream,
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
    fn hotspot_state_change_does_not_change_runtime_upstream_identity() {
        let physical = upstream(25, "WLAN", "192.168.1.6", "192.168.1.1", 0);
        let before = snapshot(false, vec![], false, Some(physical.clone()));
        let after = snapshot(true, vec!["172.22.44.0/24"], true, Some(physical));
        assert!(hotspot_topology_changed(&before, &after));
        assert_eq!(physical_upstream_identity(&before), physical_upstream_identity(&after));
    }

    #[test]
    fn windows_network_forwarding_change_changes_runtime_identity() {
        let before_physical = upstream(25, "WLAN", "192.168.1.6", "192.168.1.1", 0);
        let mut after_physical = before_physical.clone();
        after_physical.forwarding_enabled = true;
        let before = snapshot(false, vec![], false, Some(before_physical));
        let after = snapshot(true, vec![], true, Some(after_physical));
        let before_identity = physical_upstream_identity(&before);
        let after_identity = physical_upstream_identity(&after);
        assert_ne!(before_identity, after_identity);
        assert!(forwarding_state_changed(
            before_identity.as_ref(),
            after_identity.as_ref()
        ));
    }

    #[test]
    fn route_metric_churn_does_not_change_runtime_upstream_identity() {
        let before = snapshot(
            false,
            vec![],
            false,
            Some(upstream(25, "WLAN", "192.168.1.6", "192.168.1.1", 0)),
        );
        let after = snapshot(
            false,
            vec![],
            false,
            Some(upstream(25, "WLAN", "192.168.1.6", "192.168.1.1", 50)),
        );
        assert_eq!(physical_upstream_identity(&before), physical_upstream_identity(&after));
    }

    #[test]
    fn real_physical_upstream_change_changes_runtime_identity() {
        let before = snapshot(
            false,
            vec![],
            false,
            Some(upstream(25, "WLAN", "192.168.1.6", "192.168.1.1", 0)),
        );
        let after = snapshot(
            false,
            vec![],
            false,
            Some(upstream(8, "Ethernet", "10.0.0.6", "10.0.0.1", 0)),
        );
        assert_ne!(physical_upstream_identity(&before), physical_upstream_identity(&after));
    }
}
