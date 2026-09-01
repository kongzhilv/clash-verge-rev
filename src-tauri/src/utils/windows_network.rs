use anyhow::{Result, anyhow};
use serde_yaml_ng::{Mapping, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::c_void,
    net::Ipv4Addr,
    ptr::null_mut,
    slice, thread,
    time::Duration,
};
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
    skip_as_source: bool,
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
    pub forwarding_enabled: bool,
    pub route_exclude_addresses: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ManagedProxyBindingStats {
    pub inline_applied: usize,
    pub inline_preserved: usize,
    pub provider_applied: usize,
    pub provider_preserved: usize,
    pub provider_override_invalid: usize,
}

impl WindowsUpstreamRoute {
    fn signature(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}",
            self.interface_index, self.interface_alias, self.source_address, self.gateway, self.forwarding_enabled
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
            .filter(|row| row.DadState == IpDadStatePreferred)
            .filter_map(|row| {
                let address = ipv4_from_sockaddr(&row.Address)?;
                if address.is_unspecified() || address.is_loopback() || address.is_link_local() {
                    return None;
                }
                Some(WindowsIpv4Address {
                    interface_index: row.InterfaceIndex,
                    address,
                    prefix_length: row.OnLinkPrefixLength,
                    skip_as_source: row.SkipAsSource,
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
                    && ipv4_from_sockaddr(&row.DestinationPrefix.Prefix).is_some_and(|address| address.is_unspecified())
                    && ipv4_from_sockaddr(&row.NextHop).is_some_and(|address| !address.is_unspecified())
            })
            .copied()
            .collect::<Vec<_>>()
    };

    unsafe { FreeMibTable(table.cast::<c_void>()) };
    Ok(result)
}

fn connected_interface_state(interface_index: u32) -> Option<(u32, bool)> {
    let mut row = MIB_IPINTERFACE_ROW {
        Family: AF_INET,
        InterfaceIndex: interface_index,
        ..Default::default()
    };
    let status = unsafe { GetIpInterfaceEntry(&mut row) };
    if status.0 == 0 && row.Connected && !row.DisableDefaultRoutes {
        Some((row.Metric, row.ForwardingEnabled))
    } else {
        None
    }
}

fn interface_identity(interface: &WindowsInterface) -> String {
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

fn is_hotspot_side(interface: &WindowsInterface) -> bool {
    let identity = interface_identity(interface);
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

fn is_virtual_or_tunnel(interface: &WindowsInterface) -> bool {
    if is_hotspot_side(interface) {
        return true;
    }

    let identity = interface_identity(interface);
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

fn managed_physical_route_guards(upstream_address: &WindowsIpv4Address) -> Vec<String> {
    let mut excluded_cidrs = BTreeSet::new();
    if let Some(cidr) = ipv4_cidr(upstream_address.address, upstream_address.prefix_length)
        && upstream_address.prefix_length >= 8
    {
        excluded_cidrs.insert(cidr);
    }
    excluded_cidrs.into_iter().collect()
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
            .filter(|address| address.interface_index == route.InterfaceIndex && !address.skip_as_source)
            .min_by_key(|address| u32::from(address.address))
        else {
            continue;
        };
        let Some((interface_metric, forwarding_enabled)) = connected_interface_state(route.InterfaceIndex) else {
            continue;
        };
        let Some(gateway) = ipv4_from_sockaddr(&route.NextHop) else {
            continue;
        };

        let effective_metric = route.Metric.saturating_add(interface_metric);
        let route_exclude_addresses = managed_physical_route_guards(source);

        candidates.push(WindowsUpstreamRoute {
            interface_index: route.InterfaceIndex,
            interface_alias: interface.alias.clone(),
            interface_description: interface.description.clone(),
            source_address: source.address.to_string(),
            gateway: gateway.to_string(),
            route_metric: route.Metric,
            interface_metric,
            effective_metric,
            forwarding_enabled,
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
            "Windows physical default route did not stay stable long enough (last: {} / {} / {})",
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
                Value::Sequence(values.iter().map(|value| Value::from(value.as_str())).collect()),
            );
        }
    }
}

fn apply_interface_name_if_unset(mapping: &mut Mapping, interface_alias: &str) -> bool {
    let key = Value::String("interface-name".to_owned());
    match mapping.get(&key) {
        Some(Value::String(value)) if !value.trim().is_empty() => false,
        Some(Value::String(_)) | None => {
            mapping.insert(key, Value::from(interface_alias));
            true
        }
        Some(_) => false,
    }
}

fn apply_managed_proxy_bindings(config: &mut Mapping, interface_alias: &str) -> ManagedProxyBindingStats {
    let mut stats = ManagedProxyBindingStats::default();

    if let Some(Value::Sequence(proxies)) = config.get_mut("proxies") {
        for proxy in proxies {
            let Some(proxy) = proxy.as_mapping_mut() else {
                continue;
            };
            if apply_interface_name_if_unset(proxy, interface_alias) {
                stats.inline_applied += 1;
            } else {
                stats.inline_preserved += 1;
            }
        }
    }

    if let Some(Value::Mapping(providers)) = config.get_mut("proxy-providers") {
        for provider_value in providers.values_mut() {
            let Some(provider) = provider_value.as_mapping_mut() else {
                continue;
            };
            let override_key = Value::from("override");
            match provider.get_mut(&override_key) {
                Some(Value::Mapping(override_map)) => {
                    if apply_interface_name_if_unset(override_map, interface_alias) {
                        stats.provider_applied += 1;
                    } else {
                        stats.provider_preserved += 1;
                    }
                }
                Some(_) => {
                    stats.provider_override_invalid += 1;
                }
                None => {
                    let mut override_map = Mapping::new();
                    override_map.insert(Value::String("interface-name".to_owned()), Value::from(interface_alias));
                    provider.insert(override_key, Value::Mapping(override_map));
                    stats.provider_applied += 1;
                }
            }
        }
    }

    stats
}

fn forwarding_safe_route_addresses(config: &Mapping) -> Vec<String> {
    let Some(dns) = config.get("dns").and_then(Value::as_mapping) else {
        return Vec::new();
    };
    if dns.get("enhanced-mode").and_then(Value::as_str) != Some("fake-ip") {
        return Vec::new();
    }

    let mut routes = Vec::new();
    if let Some(range) = dns
        .get("fake-ip-range")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        routes.push(range.to_owned());
    }

    let ipv6_enabled = config.get("ipv6").and_then(Value::as_bool).unwrap_or(false);
    if ipv6_enabled
        && let Some(range) = dns
            .get("fake-ip-range6")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
    {
        routes.push(range.to_owned());
    }
    routes
}

fn apply_forwarding_safe_tun_route(config: &mut Mapping, forwarding_enabled: bool) -> bool {
    if !forwarding_enabled {
        return false;
    }
    let route_addresses = forwarding_safe_route_addresses(config);
    let Some(Value::Mapping(tun)) = config.get_mut("tun") else {
        return false;
    };
    let enabled = tun.get("enable").and_then(Value::as_bool).unwrap_or(false);
    let auto_route = tun.get("auto-route").and_then(Value::as_bool).unwrap_or(false);
    if !enabled || !auto_route {
        return false;
    }

    if route_addresses.is_empty() {
        // Windows cannot safely combine physical IP forwarding with Mihomo's
        // ordinary global TUN default route. If fake-IP routing is unavailable,
        // fail closed on auto-route instead of black-holing the host in a loop.
        tun.insert(Value::from("auto-route"), Value::from(false));
        tun.remove("route-address");
        return true;
    }

    // Mihomo route-address replaces the default route when auto-route is enabled.
    // In Windows forwarding/hotspot mode route only the final fake-IP CIDR(s),
    // preserving the physical default route for Mihomo's own outbound sockets.
    tun.insert(
        Value::from("route-address"),
        Value::Sequence(route_addresses.into_iter().map(Value::from).collect()),
    );
    true
}

pub fn apply_managed_upstream(config: &mut Mapping, route: &WindowsUpstreamRoute) -> ManagedProxyBindingStats {
    apply_forwarding_safe_tun_route(config, route.forwarding_enabled);
    if let Some(Value::Mapping(tun)) = config.get_mut("tun") {
        // Runtime routing is intentionally independent from Mobile Hotspot state.
        // Only the stable physical LAN guard is merged here. Hotspot lifecycle,
        // Wi-Fi Direct churn and ICS private subnets belong exclusively to WinRT.
        merge_string_sequence(tun, "route-exclude-address", &route.route_exclude_addresses);
    }

    // Bind Mihomo-owned proxy/provider sockets to the stable physical NIC. The
    // top-level all-outbound lease is applied separately by windows_managed_interface.
    apply_managed_proxy_bindings(config, route.interface_alias.as_str())
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod tests {
    use super::{
        ManagedProxyBindingStats, WindowsInterface, WindowsIpv4Address, WindowsUpstreamRoute, apply_managed_upstream,
        ipv4_cidr, is_hotspot_side, managed_physical_route_guards, tun_needs_managed_upstream,
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
            forwarding_enabled: false,
            route_exclude_addresses: vec!["192.168.1.0/24".into()],
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
    fn managed_upstream_uses_physical_only_runtime_guards() {
        let mut config = mapping("{tun: {enable: true, auto-route: true, auto-detect-interface: true}}");
        apply_managed_upstream(&mut config, &route());

        assert!(config.get("interface-name").is_none());
        let tun = config.get("tun").and_then(Value::as_mapping).unwrap();
        assert_eq!(tun.get("auto-detect-interface").and_then(Value::as_bool), Some(true));
        assert!(tun.get("exclude-interface").is_none());
        let routes = tun.get("route-exclude-address").and_then(Value::as_sequence).unwrap();
        assert!(routes.iter().any(|value| value.as_str() == Some("192.168.1.0/24")));
        assert!(!routes.iter().any(|value| value.as_str() == Some("172.22.44.0/24")));
    }

    #[test]
    fn managed_upstream_preserves_user_strict_route() {
        let mut enabled = mapping("{tun: {enable: true, auto-route: true, strict-route: true}}");
        apply_managed_upstream(&mut enabled, &route());
        let enabled_tun = enabled.get("tun").and_then(Value::as_mapping).unwrap();
        assert_eq!(enabled_tun.get("strict-route").and_then(Value::as_bool), Some(true));

        let mut disabled = mapping("{tun: {enable: true, auto-route: true, strict-route: false}}");
        apply_managed_upstream(&mut disabled, &route());
        let disabled_tun = disabled.get("tun").and_then(Value::as_mapping).unwrap();
        assert_eq!(disabled_tun.get("strict-route").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn managed_proxy_sockets_bind_to_stable_physical_interface() {
        let mut config = mapping(
            r"
tun:
  enable: true
  auto-route: true
proxies:
  - {name: inline-a, type: ss, server: 203.0.113.10, port: 443}
  - {name: inline-user, type: ss, server: 203.0.113.11, port: 443, interface-name: Ethernet}
proxy-providers:
  remote:
    type: http
    url: https://example.test/provider.yaml
",
        );
        let stats = apply_managed_upstream(&mut config, &route());
        assert_eq!(
            stats,
            ManagedProxyBindingStats {
                inline_applied: 1,
                inline_preserved: 1,
                provider_applied: 1,
                provider_preserved: 0,
                provider_override_invalid: 0,
            }
        );

        let proxies = config.get("proxies").and_then(Value::as_sequence).unwrap();
        assert_eq!(
            proxies[0]
                .as_mapping()
                .and_then(|proxy| proxy.get("interface-name"))
                .and_then(Value::as_str),
            Some("WLAN")
        );
        assert_eq!(
            proxies[1]
                .as_mapping()
                .and_then(|proxy| proxy.get("interface-name"))
                .and_then(Value::as_str),
            Some("Ethernet")
        );

        let provider = config
            .get("proxy-providers")
            .and_then(Value::as_mapping)
            .and_then(|providers| providers.get("remote"))
            .and_then(Value::as_mapping)
            .unwrap();
        assert_eq!(
            provider
                .get("override")
                .and_then(Value::as_mapping)
                .and_then(|override_map| override_map.get("interface-name"))
                .and_then(Value::as_str),
            Some("WLAN")
        );
    }

    #[test]
    fn explicit_provider_binding_is_preserved() {
        let mut config = mapping(
            r"
tun: {enable: true, auto-route: true}
proxy-providers:
  remote:
    type: http
    url: https://example.test/provider.yaml
    override:
      interface-name: Ethernet
",
        );
        let stats = apply_managed_upstream(&mut config, &route());
        assert_eq!(stats.provider_applied, 0);
        assert_eq!(stats.provider_preserved, 1);

        let interface = config
            .get("proxy-providers")
            .and_then(Value::as_mapping)
            .and_then(|providers| providers.get("remote"))
            .and_then(Value::as_mapping)
            .and_then(|provider| provider.get("override"))
            .and_then(Value::as_mapping)
            .and_then(|override_map| override_map.get("interface-name"))
            .and_then(Value::as_str);
        assert_eq!(interface, Some("Ethernet"));
    }

    #[test]
    fn existing_route_excludes_are_preserved_without_hotspot_interface_mutation() {
        let mut config = mapping(
            "{tun: {enable: true, auto-route: true, include-interface: [Ethernet], route-exclude-address: [10.0.0.0/8]}}",
        );
        apply_managed_upstream(&mut config, &route());

        let tun = config.get("tun").and_then(Value::as_mapping).unwrap();
        assert!(tun.get("exclude-interface").is_none());
        let routes = tun.get("route-exclude-address").and_then(Value::as_sequence).unwrap();
        assert!(routes.iter().any(|value| value.as_str() == Some("10.0.0.0/8")));
        assert!(routes.iter().any(|value| value.as_str() == Some("192.168.1.0/24")));
    }

    #[test]
    fn wifi_direct_filter_components_are_not_managed_as_hotspot_interfaces() {
        let real = WindowsInterface {
            index: 27,
            alias: "Local Area Connection* 10".into(),
            description: "Microsoft Wi-Fi Direct Virtual Adapter #2".into(),
            is_up: true,
        };
        let filter = WindowsInterface {
            index: 33,
            alias: "Local Area Connection* 10-WFP Native MAC Layer LightWeight Filter-0000".into(),
            description: "Microsoft Wi-Fi Direct Virtual Adapter #2-WFP Native MAC Layer LightWeight Filter-0000"
                .into(),
            is_up: true,
        };
        assert!(is_hotspot_side(&real));
        assert!(!is_hotspot_side(&filter));
    }

    #[test]
    fn physical_route_guards_only_track_physical_lan() {
        let upstream = WindowsIpv4Address {
            interface_index: 28,
            address: Ipv4Addr::new(192, 168, 1, 13),
            prefix_length: 24,
            skip_as_source: false,
        };
        assert_eq!(managed_physical_route_guards(&upstream), vec!["192.168.1.0/24"]);
    }

    #[test]
    fn route_signature_ignores_metric_churn_and_runtime_guards() {
        let before = route();
        let mut after = before.clone();
        after.route_metric = 50;
        after.interface_metric = 75;
        after.effective_metric = 125;
        after.route_exclude_addresses = vec!["10.0.0.0/8".into()];
        assert_eq!(before.signature(), after.signature());
    }

    #[test]
    fn windows_network_forwarding_safe_tun_routes_only_fake_ip_range() {
        let mut config = mapping(
            "{ipv6: false, tun: {enable: true, auto-route: true}, dns: {enhanced-mode: fake-ip, fake-ip-range: 198.18.0.1/16}}",
        );
        let mut forwarding = route();
        forwarding.forwarding_enabled = true;
        apply_managed_upstream(&mut config, &forwarding);

        let tun = config.get("tun").and_then(Value::as_mapping).unwrap();
        assert_eq!(tun.get("auto-route").and_then(Value::as_bool), Some(true));
        let routes = tun.get("route-address").and_then(Value::as_sequence).unwrap();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].as_str(), Some("198.18.0.1/16"));
        assert!(!routes.iter().any(|value| value.as_str() == Some("0.0.0.0/0")));
    }

    #[test]
    fn windows_network_forwarding_safe_tun_uses_custom_fake_ip_range() {
        let mut config = mapping(
            "{ipv6: false, tun: {enable: true, auto-route: true, route-address: [0.0.0.0/0]}, dns: {enhanced-mode: fake-ip, fake-ip-range: 198.19.0.1/16}}",
        );
        let mut forwarding = route();
        forwarding.forwarding_enabled = true;
        apply_managed_upstream(&mut config, &forwarding);

        let routes = config
            .get("tun")
            .and_then(Value::as_mapping)
            .and_then(|tun| tun.get("route-address"))
            .and_then(Value::as_sequence)
            .unwrap();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].as_str(), Some("198.19.0.1/16"));
    }

    #[test]
    fn windows_network_forwarding_without_fake_ip_disables_global_auto_route() {
        let mut config = mapping("{tun: {enable: true, auto-route: true}, dns: {enhanced-mode: redir-host}}");
        let mut forwarding = route();
        forwarding.forwarding_enabled = true;
        apply_managed_upstream(&mut config, &forwarding);
        let tun = config.get("tun").and_then(Value::as_mapping).unwrap();
        assert_eq!(tun.get("auto-route").and_then(Value::as_bool), Some(false));
        assert!(tun.get("route-address").is_none());
    }

    #[test]
    fn windows_network_forwarding_change_changes_stable_route_signature() {
        let before = route();
        let mut after = before.clone();
        after.forwarding_enabled = true;
        assert_ne!(before.signature(), after.signature());
    }

    #[test]
    fn cidr_uses_the_interface_prefix() {
        assert_eq!(
            ipv4_cidr(Ipv4Addr::new(10, 37, 12, 1), 24).as_deref(),
            Some("10.37.12.0/24")
        );
    }
}
