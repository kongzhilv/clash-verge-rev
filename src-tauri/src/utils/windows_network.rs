use anyhow::{Result, anyhow};
use serde_yaml_ng::{Mapping, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::c_void;
use std::net::Ipv4Addr;
use std::ptr::null_mut;
use std::slice;
use std::thread;
use std::time::Duration;
use windows::Win32::NetworkManagement::IpHelper::{
    FreeMibTable, GetIfTable2, GetIpForwardTable2, GetIpInterfaceEntry,
    GetUnicastIpAddressTable, MIB_IF_ROW2, MIB_IF_TABLE2, MIB_IPFORWARD_ROW2,
    MIB_IPFORWARD_TABLE2, MIB_IPINTERFACE_ROW, MIB_UNICASTIPADDRESS_ROW,
    MIB_UNICASTIPADDRESS_TABLE,
};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::Win32::Networking::WinSock::{AF_INET, IpDadStatePreferred, SOCKADDR_INET};

const STABLE_SAMPLES: usize = 6;
const MAX_SAMPLES: usize = 24;
const SAMPLE_DELAY: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowsInterface {
    index: u32,
    alias: String,
    description: String,
    is_up: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowsIpv4Address {
    interface_index: u32,
    address: Ipv4Addr,
    prefix_length: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsUpstreamRoute {
    pub interface_index: u32,
    pub interface_alias: String,
    pub interface_description: String,
    pub source_address: String,
    pub gateway: String,
    pub route_metric: u32,
    pub interface_metric: u32,
    pub effective_metric: u32,
    pub excluded_interfaces: Vec<String>,
    pub route_exclude_addresses: Vec<String>,
}

impl WindowsUpstreamRoute {
    fn signature(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}",
            self.interface_index,
            self.source_address,
            self.gateway,
            self.excluded_interfaces.join(","),
            self.route_exclude_addresses.join(",")
        )
    }
}

fn utf16z(value: &[u16]) -> String {
    let len = value.iter().position(|item| *item == 0).unwrap_or(value.len());
    String::from_utf16_lossy(&value[..len])
}

fn win32_error(operation: &str, status: u32) -> anyhow::Error {
    anyhow!("{operation} failed with Windows error {status}")
}

fn ipv4_from_sockaddr(value: &SOCKADDR_INET) -> Option<Ipv4Addr> {
    let family = unsafe { value.si_family };
    if family != AF_INET {
        return None;
    }

    let raw = unsafe { value.Ipv4.sin_addr.S_un.S_addr };
    Some(Ipv4Addr::from(raw.to_ne_bytes()))
}

fn load_interfaces() -> Result<Vec<WindowsInterface>> {
    let mut table: *mut MIB_IF_TABLE2 = null_mut();
    let status = unsafe { GetIfTable2(&mut table) };
    if status.0 != 0 || table.is_null() {
        return Err(win32_error("GetIfTable2", status.0));
    }

    let result = unsafe {
        let table_ref = &*table;
        let rows = slice::from_raw_parts(table_ref.Table.as_ptr(), table_ref.NumEntries as usize);
        rows.iter()
            .map(|row: &MIB_IF_ROW2| WindowsInterface {
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

fn load_ipv4_addresses() -> Result<Vec<WindowsIpv4Address>> {
    let mut table: *mut MIB_UNICASTIPADDRESS_TABLE = null_mut();
    let status = unsafe { GetUnicastIpAddressTable(AF_INET, &mut table) };
    if status.0 != 0 || table.is_null() {
        return Err(win32_error("GetUnicastIpAddressTable", status.0));
    }

    let result = unsafe {
        let table_ref = &*table;
        let rows: &[MIB_UNICASTIPADDRESS_ROW] =
            slice::from_raw_parts(table_ref.Table.as_ptr(), table_ref.NumEntries as usize);
        rows.iter()
            .filter(|row| row.DadState == IpDadStatePreferred && !row.SkipAsSource)
            .filter_map(|row| {
                let address = ipv4_from_sockaddr(&row.Address)?;
                if address.is_unspecified() || address.is_loopback() || address.is_link_local() {
                    return None;
                }
                Some(WindowsIpv4Address {
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
        return Err(win32_error("GetIpForwardTable2", status.0));
    }

    let result = unsafe {
        let table_ref = &*table;
        let rows = slice::from_raw_parts(table_ref.Table.as_ptr(), table_ref.NumEntries as usize);
        rows.iter()
            .filter(|row| {
                row.DestinationPrefix.PrefixLength == 0
                    && ipv4_from_sockaddr(&row.DestinationPrefix.Prefix)
                        .is_some_and(|address| address.is_unspecified())
                    && ipv4_from_sockaddr(&row.NextHop)
                        .is_some_and(|address| !address.is_unspecified())
            })
            .copied()
            .collect::<Vec<_>>()
    };

    unsafe { FreeMibTable(table.cast::<c_void>()) };
    Ok(result)
}

fn connected_interface_metric(interface_index: u32) -> Option<u32> {
    let mut row = MIB_IPINTERFACE_ROW {
        Family: AF_INET,
        InterfaceIndex: interface_index,
        ..Default::default()
    };
    let status = unsafe { GetIpInterfaceEntry(&mut row) };
    if status.0 == 0 && row.Connected && !row.DisableDefaultRoutes {
        Some(row.Metric)
    } else {
        None
    }
}

fn is_hotspot_side(interface: &WindowsInterface) -> bool {
    let identity = format!("{} {}", interface.alias, interface.description).to_lowercase();
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

fn is_virtual_or_tunnel(interface: &WindowsInterface) -> bool {
    if is_hotspot_side(interface) {
        return true;
    }

    let identity = format!("{} {}", interface.alias, interface.description).to_lowercase();
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

fn managed_route_guards(
    interfaces: &BTreeMap<u32, WindowsInterface>,
    addresses: &[WindowsIpv4Address],
    upstream_address: &WindowsIpv4Address,
) -> (Vec<String>, Vec<String>) {
    let mut excluded_interfaces = BTreeSet::new();
    let mut excluded_cidrs = BTreeSet::new();

    if let Some(cidr) = ipv4_cidr(upstream_address.address, upstream_address.prefix_length) {
        if upstream_address.prefix_length >= 8 {
            excluded_cidrs.insert(cidr);
        }
    }

    for interface in interfaces.values().filter(|interface| interface.is_up) {
        if !is_hotspot_side(interface) {
            continue;
        }

        if !interface.alias.trim().is_empty() {
            excluded_interfaces.insert(interface.alias.clone());
        }

        for address in addresses
            .iter()
            .filter(|address| address.interface_index == interface.index)
        {
            if !address.address.is_private() || !(8..=30).contains(&address.prefix_length) {
                continue;
            }
            if let Some(cidr) = ipv4_cidr(address.address, address.prefix_length) {
                excluded_cidrs.insert(cidr);
            }
        }
    }

    (
        excluded_interfaces.into_iter().collect(),
        excluded_cidrs.into_iter().collect(),
    )
}

fn query_upstream_route() -> Result<WindowsUpstreamRoute> {
    let interfaces = load_interfaces()?;
    let addresses = load_ipv4_addresses()?;
    let routes = load_default_routes()?;
    let interfaces = interfaces
        .into_iter()
        .map(|interface| (interface.index, interface))
        .collect::<BTreeMap<_, _>>();

    let mut candidates = Vec::new();
    for route in routes {
        let Some(interface) = interfaces.get(&route.InterfaceIndex) else {
            continue;
        };
        if !interface.is_up || is_virtual_or_tunnel(interface) {
            continue;
        }

        let Some(source) = addresses
            .iter()
            .filter(|address| address.interface_index == route.InterfaceIndex)
            .min_by_key(|address| u32::from(address.address))
        else {
            continue;
        };
        let Some(interface_metric) = connected_interface_metric(route.InterfaceIndex) else {
            continue;
        };
        let Some(gateway) = ipv4_from_sockaddr(&route.NextHop) else {
            continue;
        };
        let effective_metric = route.Metric.saturating_add(interface_metric);
        let (excluded_interfaces, route_exclude_addresses) =
            managed_route_guards(&interfaces, &addresses, source);

        candidates.push(WindowsUpstreamRoute {
            interface_index: route.InterfaceIndex,
            interface_alias: interface.alias.clone(),
            interface_description: interface.description.clone(),
            source_address: source.address.to_string(),
            gateway: gateway.to_string(),
            route_metric: route.Metric,
            interface_metric,
            effective_metric,
            excluded_interfaces,
            route_exclude_addresses,
        });
    }

    candidates
        .into_iter()
        .min_by_key(|route| {
            (
                route.effective_metric,
                route.route_metric,
                route.interface_metric,
                route.interface_index,
            )
        })
        .ok_or_else(|| anyhow!("Windows has no connected physical IPv4 default route"))
}

pub fn detect_stable_upstream() -> Result<WindowsUpstreamRoute> {
    let mut previous_signature = String::new();
    let mut stable_count = 0usize;
    let mut last_route = None;
    let mut last_error = None;

    for sample in 0..MAX_SAMPLES {
        match query_upstream_route() {
            Ok(route) => {
                let signature = route.signature();
                if signature == previous_signature {
                    stable_count += 1;
                } else {
                    previous_signature = signature;
                    stable_count = 1;
                }
                last_route = Some(route.clone());
                last_error = None;

                if stable_count >= STABLE_SAMPLES {
                    return Ok(route);
                }
            }
            Err(error) => {
                previous_signature.clear();
                stable_count = 0;
                last_error = Some(error.to_string());
            }
        }

        if sample + 1 < MAX_SAMPLES {
            thread::sleep(SAMPLE_DELAY);
        }
    }

    if let Some(route) = last_route {
        return Err(anyhow!(
            "Windows default route/hotspot topology did not stay stable long enough (last: {} / {} / {})",
            route.interface_alias,
            route.source_address,
            route.gateway
        ));
    }

    Err(anyhow!(
        "Windows has no usable physical IPv4 default route{}",
        last_error
            .as_deref()
            .map(|error| format!(": {error}"))
            .unwrap_or_default()
    ))
}

pub fn tun_needs_managed_upstream(config: &Mapping, has_explicit_interface: bool) -> bool {
    if has_explicit_interface {
        return false;
    }

    let Some(tun) = config.get("tun").and_then(Value::as_mapping) else {
        return false;
    };

    let enabled = tun.get("enable").and_then(Value::as_bool).unwrap_or(false);
    let auto_route = tun.get("auto-route").and_then(Value::as_bool).unwrap_or(false);
    enabled && auto_route
}

fn has_configured_values(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Sequence(values)) => !values.is_empty(),
        Some(Value::String(value)) => !value.trim().is_empty(),
        _ => false,
    }
}

fn merge_string_sequence(mapping: &mut Mapping, key: &str, values: &[String]) {
    if values.is_empty() {
        return;
    }

    let yaml_key = Value::from(key);
    match mapping.get_mut(&yaml_key) {
        Some(Value::Sequence(sequence)) => {
            for value in values {
                let exists = sequence
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|current| current.eq_ignore_ascii_case(value));
                if !exists {
                    sequence.push(Value::from(value.as_str()));
                }
            }
        }
        Some(existing @ Value::String(_)) => {
            let current = existing.as_str().unwrap_or_default().to_string();
            let mut sequence = Vec::new();
            if !current.trim().is_empty() {
                sequence.push(Value::from(current));
            }
            for value in values {
                if !sequence
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|current| current.eq_ignore_ascii_case(value))
                {
                    sequence.push(Value::from(value.as_str()));
                }
            }
            *existing = Value::Sequence(sequence);
        }
        Some(_) => {}
        None => {
            mapping.insert(
                yaml_key,
                Value::Sequence(
                    values
                        .iter()
                        .map(|value| Value::from(value.as_str()))
                        .collect(),
                ),
            );
        }
    }
}

pub fn apply_managed_upstream(config: &mut Mapping, route: &WindowsUpstreamRoute) {
    config.insert(
        Value::from("interface-name"),
        Value::from(route.interface_alias.as_str()),
    );

    if let Some(Value::Mapping(tun)) = config.get_mut("tun") {
        tun.insert(Value::from("auto-detect-interface"), Value::from(false));
        merge_string_sequence(
            tun,
            "route-exclude-address",
            &route.route_exclude_addresses,
        );

        // Mihomo documents include-interface and exclude-interface as mutually exclusive.
        // Preserve an explicit include-interface instead of silently creating a conflict.
        if !has_configured_values(tun.get("include-interface")) {
            merge_string_sequence(tun, "exclude-interface", &route.excluded_interfaces);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        WindowsUpstreamRoute, apply_managed_upstream, ipv4_cidr, tun_needs_managed_upstream,
    };
    use serde_yaml_ng::{Mapping, Value};
    use std::net::Ipv4Addr;

    fn mapping(yaml: &str) -> Mapping {
        serde_yaml_ng::from_str(yaml).expect("test config should be valid")
    }

    fn route() -> WindowsUpstreamRoute {
        WindowsUpstreamRoute {
            interface_index: 7,
            interface_alias: "WLAN".into(),
            interface_description: "Physical Wi-Fi".into(),
            source_address: "192.168.1.6".into(),
            gateway: "192.168.1.1".into(),
            route_metric: 0,
            interface_metric: 25,
            effective_metric: 25,
            excluded_interfaces: vec!["Local Area Connection* 12".into()],
            route_exclude_addresses: vec!["192.168.1.0/24".into(), "192.168.137.0/24".into()],
        }
    }

    #[test]
    fn managed_upstream_is_only_used_for_automatic_tun_routing() {
        let tun = mapping("{tun: {enable: true, auto-route: true, auto-detect-interface: true}}");
        assert!(tun_needs_managed_upstream(&tun, false));
        assert!(!tun_needs_managed_upstream(&tun, true));

        let disabled = mapping("{tun: {enable: false, auto-route: true}}");
        assert!(!tun_needs_managed_upstream(&disabled, false));

        let manual_route = mapping("{tun: {enable: true, auto-route: false}}");
        assert!(!tun_needs_managed_upstream(&manual_route, false));
    }

    #[test]
    fn managed_upstream_pins_interface_and_protects_lan_and_hotspot_routes() {
        let mut config = mapping("{tun: {enable: true, auto-route: true, auto-detect-interface: true}}");
        apply_managed_upstream(&mut config, &route());

        assert_eq!(
            config.get("interface-name").and_then(Value::as_str),
            Some("WLAN")
        );
        let tun = config.get("tun").and_then(Value::as_mapping).unwrap();
        assert_eq!(
            tun.get("auto-detect-interface").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            tun.get("exclude-interface")
                .and_then(Value::as_sequence)
                .and_then(|values| values.first())
                .and_then(Value::as_str),
            Some("Local Area Connection* 12")
        );
        let routes = tun
            .get("route-exclude-address")
            .and_then(Value::as_sequence)
            .unwrap();
        assert!(routes.iter().any(|value| value.as_str() == Some("192.168.1.0/24")));
        assert!(routes.iter().any(|value| value.as_str() == Some("192.168.137.0/24")));
    }

    #[test]
    fn explicit_include_interface_is_preserved_without_conflicting_exclude_interface() {
        let mut config = mapping(
            "{tun: {enable: true, auto-route: true, include-interface: [Ethernet], route-exclude-address: [10.0.0.0/8]}}",
        );
        apply_managed_upstream(&mut config, &route());

        let tun = config.get("tun").and_then(Value::as_mapping).unwrap();
        assert!(tun.get("exclude-interface").is_none());
        let routes = tun
            .get("route-exclude-address")
            .and_then(Value::as_sequence)
            .unwrap();
        assert!(routes.iter().any(|value| value.as_str() == Some("10.0.0.0/8")));
        assert!(routes.iter().any(|value| value.as_str() == Some("192.168.137.0/24")));
    }

    #[test]
    fn cidr_uses_the_interface_prefix() {
        assert_eq!(
            ipv4_cidr(Ipv4Addr::new(192, 168, 137, 1), 24).as_deref(),
            Some("192.168.137.0/24")
        );
    }
}