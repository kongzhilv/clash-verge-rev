from pathlib import Path
import re

ROOT = Path('.')


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, text):
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# 1. Windows stable-upstream lease: ForwardingEnabled becomes part of the
#    stable route state and switches auto-route into fake-IP-only routing.
# ---------------------------------------------------------------------------
path = 'src-tauri/src/utils/windows_network.rs'
s = read(path)
s = replace_once(
    s,
    '    pub effective_metric: u32,\n    pub route_exclude_addresses: Vec<String>,',
    '    pub effective_metric: u32,\n    pub forwarding_enabled: bool,\n    pub route_exclude_addresses: Vec<String>,',
    'windows_network route field',
)
s = replace_once(
    s,
    '            "{}|{}|{}|{}",\n            self.interface_index, self.interface_alias, self.source_address, self.gateway\n',
    '            "{}|{}|{}|{}|{}",\n            self.interface_index,\n            self.interface_alias,\n            self.source_address,\n            self.gateway,\n            self.forwarding_enabled\n',
    'windows_network signature',
)
s = replace_once(
    s,
    '''fn connected_interface_metric(interface_index: u32) -> Option<u32> {\n    let mut row = MIB_IPINTERFACE_ROW {\n        Family: AF_INET,\n        InterfaceIndex: interface_index,\n        ..Default::default()\n    };\n    let status = unsafe { GetIpInterfaceEntry(&mut row) };\n    if status.0 == 0 && row.Connected && !row.DisableDefaultRoutes {\n        Some(row.Metric)\n    } else {\n        None\n    }\n}\n''',
    '''fn connected_interface_state(interface_index: u32) -> Option<(u32, bool)> {\n    let mut row = MIB_IPINTERFACE_ROW {\n        Family: AF_INET,\n        InterfaceIndex: interface_index,\n        ..Default::default()\n    };\n    let status = unsafe { GetIpInterfaceEntry(&mut row) };\n    if status.0 == 0 && row.Connected && !row.DisableDefaultRoutes {\n        Some((row.Metric, row.ForwardingEnabled))\n    } else {\n        None\n    }\n}\n''',
    'windows_network interface state',
)
s = replace_once(
    s,
    '        let Some(interface_metric) = connected_interface_metric(route.InterfaceIndex) else {\n            continue;\n        };',
    '        let Some((interface_metric, forwarding_enabled)) = connected_interface_state(route.InterfaceIndex) else {\n            continue;\n        };',
    'windows_network query state',
)
s = replace_once(
    s,
    '            effective_metric,\n            route_exclude_addresses,',
    '            effective_metric,\n            forwarding_enabled,\n            route_exclude_addresses,',
    'windows_network route construction',
)
helper = r'''
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

'''
s = replace_once(
    s,
    'pub fn apply_managed_upstream(config: &mut Mapping, route: &WindowsUpstreamRoute) -> ManagedProxyBindingStats {\n',
    helper + 'pub fn apply_managed_upstream(config: &mut Mapping, route: &WindowsUpstreamRoute) -> ManagedProxyBindingStats {\n    apply_forwarding_safe_tun_route(config, route.forwarding_enabled);\n',
    'windows_network forwarding helper insertion',
)
s = replace_once(
    s,
    '            effective_metric: 25,\n            route_exclude_addresses:',
    '            effective_metric: 25,\n            forwarding_enabled: false,\n            route_exclude_addresses:',
    'windows_network test route field',
)
s = replace_once(
    s,
    '        ManagedProxyBindingStats, WindowsInterface, WindowsIpv4Address, WindowsUpstreamRoute, apply_managed_upstream,\n        ipv4_cidr, is_hotspot_side, managed_physical_route_guards, tun_needs_managed_upstream,',
    '        ManagedProxyBindingStats, WindowsInterface, WindowsIpv4Address, WindowsUpstreamRoute, apply_managed_upstream,\n        ipv4_cidr, is_hotspot_side, managed_physical_route_guards, tun_needs_managed_upstream,',
    'windows_network import anchor',
)
new_tests = r'''
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
        let mut config = mapping(
            "{tun: {enable: true, auto-route: true}, dns: {enhanced-mode: redir-host}}",
        );
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

'''
s = replace_once(
    s,
    '    #[test]\n    fn cidr_uses_the_interface_prefix() {',
    new_tests + '    #[test]\n    fn cidr_uses_the_interface_prefix() {',
    'windows_network tests insertion',
)
write(path, s)


# ---------------------------------------------------------------------------
# 2. Topology watcher: physical ForwardingEnabled is runtime-routing state.
#    Hotspot churn stays lifecycle-observability-only, but a stable forwarding
#    mode change is allowed to regenerate runtime exactly once.
# ---------------------------------------------------------------------------
path = 'src-tauri/src/core/windows_network_diagnostics.rs'
s = read(path)
s = replace_once(
    s,
    '    effective_metric: u32,\n}',
    '    effective_metric: u32,\n    forwarding_enabled: bool,\n}',
    'network diagnostics upstream snapshot field',
)
s = replace_once(
    s,
    '    gateway: String,\n}',
    '    gateway: String,\n    forwarding_enabled: bool,\n}',
    'network diagnostics identity field',
)
s = replace_once(
    s,
    '''fn interface_metric(interface_index: u32) -> Option<u32> {\n    let mut row = MIB_IPINTERFACE_ROW {\n        Family: AF_INET,\n        InterfaceIndex: interface_index,\n        ..Default::default()\n    };\n    let status = unsafe { GetIpInterfaceEntry(&mut row) };\n    (status.0 == 0 && row.Connected && !row.DisableDefaultRoutes).then_some(row.Metric)\n}\n''',
    '''fn interface_state(interface_index: u32) -> Option<(u32, bool)> {\n    let mut row = MIB_IPINTERFACE_ROW {\n        Family: AF_INET,\n        InterfaceIndex: interface_index,\n        ..Default::default()\n    };\n    let status = unsafe { GetIpInterfaceEntry(&mut row) };\n    (status.0 == 0 && row.Connected && !row.DisableDefaultRoutes)\n        .then_some((row.Metric, row.ForwardingEnabled))\n}\n''',
    'network diagnostics interface state',
)
s = s.replace('let metric = interface_metric(route.InterfaceIndex);', 'let metric = interface_state(route.InterfaceIndex).map(|state| state.0);')
s = replace_once(
    s,
    '            let interface_metric = interface_metric(interface.index)?;',
    '            let (interface_metric, forwarding_enabled) = interface_state(interface.index)?;',
    'network diagnostics physical state',
)
s = replace_once(
    s,
    '                effective_metric: route.Metric.saturating_add(interface_metric),\n            })',
    '                effective_metric: route.Metric.saturating_add(interface_metric),\n                forwarding_enabled,\n            })',
    'network diagnostics snapshot construct',
)
s = replace_once(
    s,
    '            gateway: upstream.gateway.clone(),\n        })',
    '            gateway: upstream.gateway.clone(),\n            forwarding_enabled: upstream.forwarding_enabled,\n        })',
    'network diagnostics identity construct',
)
helper2 = r'''
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

'''
s = replace_once(
    s,
    'fn hotspot_topology_changed(previous: &WindowsTopologySnapshot, current: &WindowsTopologySnapshot) -> bool {',
    helper2 + 'fn hotspot_topology_changed(previous: &WindowsTopologySnapshot, current: &WindowsTopologySnapshot) -> bool {',
    'network diagnostics forwarding helper',
)
s = s.replace('"trigger_scope": "stable-physical-upstream-only",', '"trigger_scope": "stable-physical-upstream-or-forwarding-mode",')
s = s.replace('"hotspot_events_can_trigger_core_refresh": false,', '"hotspot_events_can_trigger_core_refresh": "forwarding-mode-only",')
s = s.replace('"hotspot_mode": "observability-only",', '"hotspot_mode": "lifecycle-observability+routing-mode",')
s = s.replace('"failover_strategy": "confirm-stable-physical-upstream-then-regenerate-runtime",', '"failover_strategy": "confirm-stable-physical-upstream-or-forwarding-mode-then-regenerate-runtime",')
s = replace_once(
    s,
    '        let current_upstream = physical_upstream_identity(&current);\n        let runtime_upstream_changed = current_upstream.is_some() && current_upstream != last_runtime_upstream;',
    '        let current_upstream = physical_upstream_identity(&current);\n        let forwarding_mode_changed = forwarding_state_changed(last_runtime_upstream.as_ref(), current_upstream.as_ref());\n        let runtime_upstream_changed = current_upstream.is_some() && current_upstream != last_runtime_upstream;',
    'network diagnostics mode changed state',
)
s = replace_once(
    s,
    '''        if hotspot_changed {\n            diagnostics::info(\n                "windows-hotspot-guard",\n                "hotspot-observed-no-core-refresh",\n                json!({\n                    "previous_hotspot_present": previous.hotspot_present,\n                    "current_hotspot_present": current.hotspot_present,\n                    "previous_hotspot_subnets": &previous.hotspot_subnets,\n                    "current_hotspot_subnets": &current.hotspot_subnets,\n                    "single_owner": true,\n                    "owner": "windows-hotspot-winrt",\n                    "core_refresh_suppressed": true,\n                    "reason": "prevent-hotspot-tun-reload-feedback-loop",\n                }),\n            );\n        }\n''',
    '''        if hotspot_changed {\n            diagnostics::info(\n                "windows-hotspot-guard",\n                "hotspot-observed-routing-mode-evaluation",\n                json!({\n                    "previous_hotspot_present": previous.hotspot_present,\n                    "current_hotspot_present": current.hotspot_present,\n                    "previous_hotspot_subnets": &previous.hotspot_subnets,\n                    "current_hotspot_subnets": &current.hotspot_subnets,\n                    "single_owner": true,\n                    "owner": "windows-hotspot-winrt",\n                    "forwarding_mode_changed": forwarding_mode_changed,\n                    "lifecycle_mutation": false,\n                    "core_refresh_policy": "only-for-stable-physical-forwarding-mode-change",\n                }),\n            );\n        }\n''',
    'network diagnostics hotspot event policy',
)
old_branch = '''        if runtime_upstream_changed {\n            if hotspot_changed {\n                diagnostics::info(\n                    "windows-network-upstream",\n                    "refresh-deferred-during-hotspot-transition",\n                    json!({\n                        "candidate": &current_upstream,\n                        "last_runtime_upstream": &last_runtime_upstream,\n                        "retry": "next-ip-helper-event-or-watchdog",\n                    }),\n                );\n            } else if let Some(candidate) = current_upstream.as_ref() {\n                match confirm_physical_upstream(candidate).await {\n                    Ok(Some(confirmed)) => {\n                        let confirmed_identity = physical_upstream_identity(&confirmed);\n                        if confirmed_identity != last_runtime_upstream\n                            && refresh_runtime_network_state("physical-upstream-changed", &previous, &confirmed).await\n                        {\n                            last_runtime_upstream = confirmed_identity;\n                        }\n                    }\n                    Ok(None) => {\n                        diagnostics::info(\n                            "windows-network-upstream",\n                            "refresh-deferred-upstream-still-settling",\n                            json!({\n                                "expected": candidate,\n                                "samples": UPSTREAM_CONFIRM_SAMPLES,\n                            }),\n                        );\n                    }\n                    Err(error) => {\n                        diagnostics::warn(\n                            "windows-network-upstream",\n                            "upstream-confirmation-failed",\n                            json!({"error": error.to_string()}),\n                        );\n                    }\n                }\n            }\n        }\n'''
new_branch = '''        if runtime_upstream_changed {\n            if hotspot_changed && !forwarding_mode_changed {\n                diagnostics::info(\n                    "windows-network-upstream",\n                    "refresh-deferred-during-hotspot-transition",\n                    json!({\n                        "candidate": &current_upstream,\n                        "last_runtime_upstream": &last_runtime_upstream,\n                        "retry": "next-ip-helper-event-or-watchdog",\n                    }),\n                );\n            } else if let Some(candidate) = current_upstream.as_ref() {\n                match confirm_physical_upstream(candidate).await {\n                    Ok(Some(confirmed)) => {\n                        let confirmed_identity = physical_upstream_identity(&confirmed);\n                        let reason = if forwarding_mode_changed {\n                            "physical-forwarding-mode-changed"\n                        } else {\n                            "physical-upstream-changed"\n                        };\n                        if confirmed_identity != last_runtime_upstream\n                            && refresh_runtime_network_state(reason, &previous, &confirmed).await\n                        {\n                            last_runtime_upstream = confirmed_identity;\n                        }\n                    }\n                    Ok(None) => {\n                        diagnostics::info(\n                            "windows-network-upstream",\n                            "refresh-deferred-upstream-still-settling",\n                            json!({\n                                "expected": candidate,\n                                "samples": UPSTREAM_CONFIRM_SAMPLES,\n                            }),\n                        );\n                    }\n                    Err(error) => {\n                        diagnostics::warn(\n                            "windows-network-upstream",\n                            "upstream-confirmation-failed",\n                            json!({"error": error.to_string()}),\n                        );\n                    }\n                }\n            }\n        }\n'''
s = replace_once(s, old_branch, new_branch, 'network diagnostics refresh branch')
s = replace_once(
    s,
    '            effective_metric: route_metric.saturating_add(25),\n        }',
    '            effective_metric: route_metric.saturating_add(25),\n            forwarding_enabled: false,\n        }',
    'network diagnostics test upstream field',
)
s = replace_once(
    s,
    '        hotspot_topology_changed, is_hotspot_side, physical_upstream_identity,',
    '        forwarding_state_changed, hotspot_topology_changed, is_hotspot_side, physical_upstream_identity,',
    'network diagnostics test import',
)
new_diag_test = r'''
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
        assert!(forwarding_state_changed(before_identity.as_ref(), after_identity.as_ref()));
    }

'''
s = replace_once(
    s,
    '    #[test]\n    fn route_metric_churn_does_not_change_runtime_upstream_identity() {',
    new_diag_test + '    #[test]\n    fn route_metric_churn_does_not_change_runtime_upstream_identity() {',
    'network diagnostics forwarding test insertion',
)
write(path, s)


# ---------------------------------------------------------------------------
# 3. Native HNetCfg ownership: WinRT/Wi-Fi Direct Mobile Hotspot is Windows
#    owned and must never receive HNetCfg PRIVATE/PUBLIC mutations from Karing.
#    Keep legacy Hosted Network compatibility and diagnostics only.
# ---------------------------------------------------------------------------
path = 'src-tauri/src/core/windows_hotspot_ics.rs'
s = read(path)
s = replace_once(
    s,
    '''#[derive(Debug, Clone, PartialEq, Eq)]\nstruct TargetPair {\n    tun: InterfaceIdentity,\n    hotspot: InterfaceIdentity,\n}\n''',
    '''#[derive(Debug, Clone, Copy, PartialEq, Eq)]\nenum HotspotOwnership {\n    WindowsMobileHotspot,\n    LegacyHostedNetwork,\n}\n\n#[derive(Debug, Clone, PartialEq, Eq)]\nstruct TargetPair {\n    tun: InterfaceIdentity,\n    hotspot: InterfaceIdentity,\n    hotspot_ownership: HotspotOwnership,\n}\n''',
    'hotspot ownership enum',
)
old_hotspot_fn = '''fn is_hotspot_adapter(row: &MIB_IF_ROW2) -> bool {\n    if row.OperStatus != IfOperStatusUp {\n        return false;\n    }\n    let identity = interface_identity(row);\n    !is_filter_component(&identity)\n        && [\n            "wi-fi direct virtual adapter",\n            "wifi direct virtual adapter",\n            "microsoft hosted network",\n            "hosted network virtual",\n            "mobile hotspot",\n        ]\n        .iter()\n        .any(|marker| identity.contains(marker))\n}\n'''
new_hotspot_fn = '''fn hotspot_ownership_from_identity(identity: &str) -> Option<HotspotOwnership> {\n    if [\n        "wi-fi direct virtual adapter",\n        "wifi direct virtual adapter",\n        "mobile hotspot",\n    ]\n    .iter()\n    .any(|marker| identity.contains(marker))\n    {\n        return Some(HotspotOwnership::WindowsMobileHotspot);\n    }\n    if ["microsoft hosted network", "hosted network virtual"]\n        .iter()\n        .any(|marker| identity.contains(marker))\n    {\n        return Some(HotspotOwnership::LegacyHostedNetwork);\n    }\n    None\n}\n\nfn is_hotspot_adapter(row: &MIB_IF_ROW2) -> bool {\n    if row.OperStatus != IfOperStatusUp {\n        return false;\n    }\n    let identity = interface_identity(row);\n    !is_filter_component(&identity) && hotspot_ownership_from_identity(&identity).is_some()\n}\n'''
s = replace_once(s, old_hotspot_fn, new_hotspot_fn, 'hotspot ownership classifier')
s = replace_once(
    s,
    '''    Ok(Some(TargetPair {\n        tun: tun_candidates.remove(0),\n        hotspot: hotspot_candidates.remove(0),\n    }))\n''',
    '''    let hotspot = hotspot_candidates.remove(0);\n    let hotspot_identity = format!("{} {}", hotspot.alias, hotspot.description).to_lowercase();\n    let hotspot_ownership = hotspot_ownership_from_identity(&hotspot_identity)\n        .ok_or_else(|| anyhow!("identified hotspot adapter has no ownership classification"))?;\n\n    Ok(Some(TargetPair {\n        tun: tun_candidates.remove(0),\n        hotspot,\n        hotspot_ownership,\n    }))\n''',
    'hotspot target ownership',
)
s = replace_once(
    s,
    '        0x80004003 => "E_POINTER",\n        _ => "UNKNOWN_HRESULT",',
    '        0x80004003 => "E_POINTER",\n        0x80040201 => "EVENT_E_ALL_SUBSCRIBERS_FAILED",\n        _ => "UNKNOWN_HRESULT",',
    'hotspot HRESULT 80040201',
)
lease_guard = r'''
fn hnetcfg_lease_allowed(pair: &TargetPair) -> bool {
    pair.hotspot_ownership == HotspotOwnership::LegacyHostedNetwork
}

'''
s = replace_once(
    s,
    'fn lease_roles_are_desired(roles: &[SavedRole], pair: &TargetPair) -> bool {',
    lease_guard + 'fn lease_roles_are_desired(roles: &[SavedRole], pair: &TargetPair) -> bool {',
    'hotspot HNetCfg guard insertion',
)
s = replace_once(
    s,
    'fn apply_pair_unlocked(path: &Path, pair: &TargetPair) -> Result<()> {\n',
    'fn apply_pair_unlocked(path: &Path, pair: &TargetPair) -> Result<()> {\n    if !hnetcfg_lease_allowed(pair) {\n        bail!("refusing HNetCfg mutation for Windows-owned Mobile Hotspot/Wi-Fi Direct adapter");\n    }\n',
    'hotspot apply defensive guard',
)
s = replace_once(
    s,
    '''    match (saved, pair) {\n''',
    '''    if let Some(pair) = pair.as_ref()\n        && !hnetcfg_lease_allowed(pair)\n    {\n        if let Some(snapshot) = saved.as_ref() {\n            restore_snapshot_unlocked(path, snapshot)?;\n            diagnostics::info(\n                "windows-hotspot-ics",\n                "windows-owned-hotspot-old-lease-restored",\n                json!({\n                    "hotspot_guid": guid_string(pair.hotspot.guid),\n                    "owner": "windows-hotspot-winrt",\n                    "hnetcfg_mutation": false,\n                }),\n            );\n            return Ok("windows-owned-hotspot-old-lease-restored");\n        }\n        diagnostics::info(\n            "windows-hotspot-ics",\n            "windows-owned-hotspot-no-hnetcfg-mutation",\n            json!({\n                "hotspot_guid": guid_string(pair.hotspot.guid),\n                "hotspot_alias": pair.hotspot.alias,\n                "hotspot_description": pair.hotspot.description,\n                "owner": "windows-hotspot-winrt",\n                "hnetcfg_mutation": false,\n                "routing_owner": "windows-forwarding-safe-tun-runtime",\n            }),\n        );\n        return Ok("windows-owned-hotspot-no-hnetcfg-mutation");\n    }\n\n    match (saved, pair) {\n''',
    'hotspot reconcile ownership guard',
)
s = s.replace('"desired_topology": "mihomo-tun=public,windows-mobile-hotspot=private",', '"desired_topology": "windows-mobile-hotspot=windows-owned-no-hnetcfg;legacy-hosted-network=hnetcfg-lease",')
s = replace_once(
    s,
    '''            hotspot: InterfaceIdentity {\n                guid: GUID::from_u128(0x22222222_2222_2222_2222_222222222222),\n                alias: "Hotspot".into(),\n                description: "Microsoft Wi-Fi Direct Virtual Adapter".into(),\n            },\n        }''',
    '''            hotspot: InterfaceIdentity {\n                guid: GUID::from_u128(0x22222222_2222_2222_2222_222222222222),\n                alias: "Hotspot".into(),\n                description: "Microsoft Hosted Network Virtual Adapter".into(),\n            },\n            hotspot_ownership: HotspotOwnership::LegacyHostedNetwork,\n        }''',
    'hotspot test pair ownership',
)
s = replace_once(
    s,
    '        InterfaceIdentity, RoleMutation, SavedRole, SharingRole, TargetPair, has_unrelated_private_role,',
    '        HotspotOwnership, InterfaceIdentity, RoleMutation, SavedRole, SharingRole, TargetPair, has_unrelated_private_role,',
    'hotspot test ownership import',
)
new_hotspot_tests = r'''
    #[test]
    fn windows_network_windows_owned_wifi_direct_never_uses_hnetcfg() {
        assert_eq!(
            super::hotspot_ownership_from_identity("microsoft wi-fi direct virtual adapter #2"),
            Some(HotspotOwnership::WindowsMobileHotspot)
        );
        let mut pair = pair();
        pair.hotspot.description = "Microsoft Wi-Fi Direct Virtual Adapter #2".into();
        pair.hotspot_ownership = HotspotOwnership::WindowsMobileHotspot;
        assert!(!super::hnetcfg_lease_allowed(&pair));
    }

    #[test]
    fn windows_network_legacy_hosted_network_retains_hnetcfg_compatibility() {
        assert_eq!(
            super::hotspot_ownership_from_identity("microsoft hosted network virtual adapter"),
            Some(HotspotOwnership::LegacyHostedNetwork)
        );
        assert!(super::hnetcfg_lease_allowed(&pair()));
    }

'''
s = replace_once(
    s,
    '    #[test]\n    fn windows_network_hresult_symbols_cover_enable_sharing_failures() {',
    new_hotspot_tests + '    #[test]\n    fn windows_network_hresult_symbols_cover_enable_sharing_failures() {',
    'hotspot ownership tests insertion',
)
s = replace_once(
    s,
    '        assert_eq!(super::hresult_symbol(0x80070057u32 as i32), "E_INVALIDARG");',
    '        assert_eq!(super::hresult_symbol(0x80070057u32 as i32), "E_INVALIDARG");\n        assert_eq!(\n            super::hresult_symbol(0x80040201u32 as i32),\n            "EVENT_E_ALL_SUBSCRIBERS_FAILED"\n        );',
    'hotspot HRESULT test',
)
write(path, s)


# ---------------------------------------------------------------------------
# 4. Manager diagnostics expose final forwarding-safe route mode.
# ---------------------------------------------------------------------------
path = 'src-tauri/src/core/manager/config.rs'
s = read(path)
s = replace_once(
    s,
    '            "route_exclude_address": string_list("route-exclude-address"),',
    '            "route_address": string_list("route-address"),\n            "route_exclude_address": string_list("route-exclude-address"),',
    'manager runtime route-address snapshot',
)
s = replace_once(
    s,
    '                "effective_metric": route.effective_metric,\n                "route_exclude_addresses": &route.route_exclude_addresses,',
    '                "effective_metric": route.effective_metric,\n                "forwarding_enabled": route.forwarding_enabled,\n                "route_exclude_addresses": &route.route_exclude_addresses,',
    'manager upstream detected forwarding',
)
s = replace_once(
    s,
    '                "route_exclude_addresses": &route.route_exclude_addresses,\n                "hotspot_runtime_dependency": false,',
    '                "route_exclude_addresses": &route.route_exclude_addresses,\n                "forwarding_enabled": route.forwarding_enabled,\n                "routing_strategy": if route.forwarding_enabled { "forwarding-safe-fake-ip-only" } else { "normal-auto-route" },\n                "hotspot_runtime_dependency": "forwarding-mode-only",',
    'manager lease forwarding log',
)
s = replace_once(
    s,
    '            "Windows TUN safety: stable physical upstream={} index={} source={} gateway={} metric={}; runtime interface lease owns Mihomo outbound selection and follows IP Helper topology changes",\n            route.interface_alias,\n            route.interface_index,\n            route.source_address,\n            route.gateway,\n            route.effective_metric',
    '            "Windows TUN safety: stable physical upstream={} index={} source={} gateway={} metric={} forwarding={}; runtime interface lease owns Mihomo outbound selection and follows IP Helper topology changes",\n            route.interface_alias,\n            route.interface_index,\n            route.source_address,\n            route.gateway,\n            route.effective_metric,\n            route.forwarding_enabled',
    'manager console forwarding log',
)
s = replace_once(
    s,
    '                "failover_strategy": "topology-watcher-regenerate-runtime",',
    '                "forwarding_enabled": route.forwarding_enabled,\n                "routing_strategy": if route.forwarding_enabled { "forwarding-safe-fake-ip-only" } else { "normal-auto-route" },\n                "failover_strategy": "topology-watcher-regenerate-runtime-on-upstream-or-forwarding-mode",',
    'manager dynamic forwarding log',
)
write(path, s)


# ---------------------------------------------------------------------------
# 5. v26 source gate + dedicated Windows x64/ARM64 compile/test workflow.
# ---------------------------------------------------------------------------
gate = r'''import { readFile } from 'node:fs/promises'

const paths = {
  hotspot: 'src-tauri/src/core/windows_hotspot_ics.rs',
  network: 'src-tauri/src/core/windows_network_diagnostics.rs',
  runtime: 'src-tauri/src/utils/windows_network.rs',
  manager: 'src-tauri/src/core/manager/config.rs',
  shutdown: 'src-tauri/src/feat/window.rs',
  workflow: '.github/workflows/karing-windows-hotspot-v26.yml',
}

const source = Object.fromEntries(
  await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(path, 'utf8')])),
)
const failures = []
const requireText = (key, text, label) => {
  if (!source[key].includes(text)) failures.push(`${label}: missing ${text}`)
}
const forbidText = (key, text, label) => {
  if (source[key].includes(text)) failures.push(`${label}: contains forbidden ${text}`)
}

for (const forbidden of [
  'NetworkOperatorTetheringManager', 'CreateFromConnectionProfile', 'StartTetheringAsync',
  'StopTetheringAsync', 'TetheringOperationalState', 'powershell.exe', 'pwsh.exe',
  'netsh ', 'Set-NetIPInterface', 'IPEnableRouter',
]) forbidText('hotspot', forbidden, `Windows/user must own Mobile Hotspot lifecycle ${forbidden}`)

for (const marker of [
  'HotspotOwnership', 'WindowsMobileHotspot', 'LegacyHostedNetwork',
  'windows-owned-hotspot-no-hnetcfg-mutation', 'hnetcfg_lease_allowed',
  'refusing HNetCfg mutation for Windows-owned Mobile Hotspot/Wi-Fi Direct adapter',
  'EVENT_E_ALL_SUBSCRIBERS_FAILED', 'hresult=0x', 'error_chain',
  'windows_network_windows_owned_wifi_direct_never_uses_hnetcfg',
  'windows_network_legacy_hosted_network_retains_hnetcfg_compatibility',
]) requireText('hotspot', marker, `Mobile Hotspot ownership/HNetCfg invariant ${marker}`)

for (const forbidden of ['192.168.137.', 'Local Area Connection*', '本地连接*'])
  forbidText('hotspot', forbidden, `Hotspot implementation stays identity-driven ${forbidden}`)

for (const marker of [
  'forwarding_enabled', 'forwarding_state_changed', 'physical-forwarding-mode-changed',
  'hotspot-observed-routing-mode-evaluation',
  '"hotspot_events_can_trigger_core_refresh": "forwarding-mode-only"',
  'confirm_physical_upstream', 'refresh_runtime_network_state',
  'windows_network_forwarding_change_changes_runtime_identity',
]) requireText('network', marker, `Forwarding-mode topology invariant ${marker}`)
for (const forbidden of ['hotspot-observed-no-core-refresh', '"hotspot_events_can_trigger_core_refresh": false'])
  forbidText('network', forbidden, `v25 stale no-refresh assumption must be retired ${forbidden}`)

for (const marker of [
  'connected_interface_state', 'forwarding_enabled', 'apply_forwarding_safe_tun_route',
  'forwarding_safe_route_addresses', 'route-address', 'fake-ip-range',
  'windows_network_forwarding_safe_tun_routes_only_fake_ip_range',
  'windows_network_forwarding_safe_tun_uses_custom_fake_ip_range',
  'windows_network_forwarding_without_fake_ip_disables_global_auto_route',
  'windows_network_forwarding_change_changes_stable_route_signature',
  'managed_physical_route_guards', 'managed_proxy_sockets_bind_to_stable_physical_interface',
]) requireText('runtime', marker, `Forwarding-safe TUN invariant ${marker}`)

for (const marker of [
  '"route_address": string_list("route-address")', 'forwarding_enabled',
  'forwarding-safe-fake-ip-only', 'topology-watcher-regenerate-runtime-on-upstream-or-forwarding-mode',
]) requireText('manager', marker, `Final Runtime diagnostic invariant ${marker}`)

requireText('shutdown', 'windows_hotspot_ics::restore_now("shutdown")', 'shutdown keeps legacy lease rollback')

for (const marker of [
  'check-windows-hotspot-zero-owner-v26.mjs',
  'Compile v26 network path ${{ matrix.target }}',
  'Run v26 forwarding-safe + ICS + topology regressions',
  'cargo check --target ${{ matrix.target }} --workspace --all-features',
  'windows_network_forwarding_safe_tun_routes_only_fake_ip_range',
  'windows_network_forwarding_change_changes_runtime_identity',
  'windows_network_windows_owned_wifi_direct_never_uses_hnetcfg',
]) requireText('workflow', marker, `v26 workflow regression ${marker}`)

if (failures.length) {
  console.error('Windows Mobile Hotspot v26 forwarding-safe safety gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('[通过] WinRT/Wi-Fi Direct Mobile Hotspot 生命周期和 HNetCfg 数据面均保持 Windows 所有，Karing 不再对其 EnableSharing')
console.log('[通过] 物理上游 ForwardingEnabled 进入稳定 Runtime 身份；状态变化可触发一次受控 Runtime 重生成')
console.log('[通过] Forwarding=true 时 Mihomo auto-route 仅安装最终 fake-IP route-address，不再安装 Windows TUN 默认路由')
console.log('[通过] 无 fake-IP 可用时 fail-closed 关闭 auto-route，避免整机回环断网')
console.log('[通过] 代理/provider socket 继续绑定稳定物理上游，用户显式 interface-name 优先语义保持')
console.log('[通过] HNetCfg 仅保留 legacy Hosted Network 兼容；0x80040201 映射 EVENT_E_ALL_SUBSCRIBERS_FAILED 并保留完整错误链')
'''
write('scripts/check-windows-hotspot-zero-owner-v26.mjs', gate)

v25 = read('.github/workflows/karing-windows-hotspot-v25.yml')
v26 = v25.replace('v25', 'v26').replace('V25', 'V26')
v26 = v26.replace('Karing Windows Hotspot v26 lifecycle/data-plane safety', 'Karing Windows Hotspot v26 forwarding-safe routing/ownership safety')
v26 = v26.replace('Karing Windows Mobile Hotspot v26 生命周期/数据面审查', 'Karing Windows Mobile Hotspot v26 转发安全路由/所有权审查')
v26 = v26.replace('Validate hotspot lifecycle + native ICS invariants', 'Validate hotspot forwarding-safe + ownership invariants')
v26 = v26.replace('Run v26 lifecycle/data-plane safety gate', 'Run v26 forwarding-safe routing/ownership safety gate')
v26 = v26.replace('Run v26 lifecycle + ICS + topology regressions', 'Run v26 forwarding-safe + ICS + topology regressions')
v26 = v26.replace('fix/karing-windows-hotspot-v26-zero-owner', 'fix/karing-windows-hotspot-v26-forwarding-safe')
# Ensure the new gate itself retriggers its workflow.
v26 = v26.replace("      - 'scripts/check-windows-hotspot-zero-owner-v26.mjs'", "      - 'scripts/check-windows-hotspot-zero-owner-v26.mjs'\n      - 'src-tauri/src/core/manager/config.rs'")
extra_steps = '''\n      - name: Prove forwarding mode uses fake-IP-only route-address\n        working-directory: src-tauri\n        run: cargo test --target x86_64-pc-windows-msvc --lib windows_network_forwarding_safe_tun_routes_only_fake_ip_range --all-features -- --exact --nocapture\n      - name: Prove physical ForwardingEnabled changes Runtime identity\n        working-directory: src-tauri\n        run: cargo test --target x86_64-pc-windows-msvc --lib windows_network_forwarding_change_changes_runtime_identity --all-features -- --exact --nocapture\n      - name: Prove WinRT Wi-Fi Direct hotspot never uses HNetCfg\n        working-directory: src-tauri\n        run: cargo test --target x86_64-pc-windows-msvc --lib windows_network_windows_owned_wifi_direct_never_uses_hnetcfg --all-features -- --exact --nocapture\n'''
v26 = v26.rstrip() + extra_steps + '\n'
write('.github/workflows/karing-windows-hotspot-v26.yml', v26)

# Retire historical v24/v25 feature-branch push gates. They remain dispatchable
# and preserve their historical checks, but must not judge later release semantics.
for old_path in ['.github/workflows/karing-windows-hotspot-v24.yml', '.github/workflows/karing-windows-hotspot-v25.yml']:
    old = read(old_path)
    old = old.replace('      - feature/karing-style-diversion\n    paths:\n      - \'.github/workflows/karing-diagnostics-once.yml\'', '    paths:\n      - \'.github/workflows/karing-diagnostics-once.yml\'', 1)
    write(old_path, old)


# ---------------------------------------------------------------------------
# 6. Main release + observer become .26 and certify the new semantics.
# ---------------------------------------------------------------------------
path = '.github/workflows/karing-diagnostics-once.yml'
s = read(path)
s = s.replace('运行 Windows Mobile Hotspot v25 生命周期/数据面安全回归', '运行 Windows Mobile Hotspot v26 转发安全路由/所有权回归')
s = s.replace('node scripts/check-windows-hotspot-zero-owner-v25.mjs', 'node scripts/check-windows-hotspot-zero-owner-v26.mjs')
old_checks = '''          check_contains src-tauri/src/core/windows_hotspot_ics.rs 'hotspot_private_preserved_when_unchanged' '热点 PRIVATE 已是目标角色时采用最小差异且不抖动'\n          check_contains src-tauri/src/core/windows_hotspot_ics.rs 'mihomo-tun-as-ics-public-with-minimal-diff-persistent-rollback' '热点 VPN 数据面使用持久最小差异 ICS lease'\n          check_contains src-tauri/src/core/windows_hotspot_ics.rs 'hotspot-private-then-tun-public' '未暴露 PRIVATE 角色时先准备热点 PRIVATE 再切 Mihomo PUBLIC'\n          check_contains src-tauri/src/core/windows_hotspot_ics.rs 'hresult=0x' 'EnableSharing 失败记录 HRESULT'\n          check_contains src-tauri/src/core/windows_hotspot_ics.rs 'error_chain' 'ICS 失败保留完整错误链'\n'''
new_checks = '''          check_contains src-tauri/src/core/windows_hotspot_ics.rs 'windows-owned-hotspot-no-hnetcfg-mutation' 'WinRT/Wi-Fi Direct Mobile Hotspot 不再由 HNetCfg 接管'\n          check_contains src-tauri/src/utils/windows_network.rs 'apply_forwarding_safe_tun_route' 'Windows Forwarding 模式启用 fake-IP-only TUN 路由'\n          check_contains src-tauri/src/core/windows_network_diagnostics.rs 'physical-forwarding-mode-changed' '物理 ForwardingEnabled 变化触发受控 Runtime 重生成'\n          check_contains src-tauri/src/core/manager/config.rs 'forwarding-safe-fake-ip-only' '最终 Runtime 记录 forwarding-safe 路由策略'\n          check_contains src-tauri/src/core/windows_hotspot_ics.rs 'EVENT_E_ALL_SUBSCRIBERS_FAILED' '0x80040201 COM 错误已映射为标准符号'\n          check_contains src-tauri/src/core/windows_hotspot_ics.rs 'hresult=0x' 'Legacy HNetCfg EnableSharing 失败记录 HRESULT'\n          check_contains src-tauri/src/core/windows_hotspot_ics.rs 'error_chain' 'Legacy HNetCfg 失败保留完整错误链'\n'''
s = replace_once(s, old_checks, new_checks, 'main workflow release checks')
old_build = '''          Windows Mobile Hotspot lifecycle: Windows/user-owned; Karing Start/Stop mutation paths = 0\n          Windows Mobile Hotspot VPN data plane: native HNetCfg ICS minimal-diff lease; Mihomo TUN=PUBLIC, hotspot=PRIVATE\n          Windows Mobile Hotspot ICS apply order: preserve existing PRIVATE; otherwise hotspot PRIVATE before Mihomo PUBLIC\n          Windows Mobile Hotspot ICS diagnostics: EnableSharing HRESULT/symbol + full error chain retained\n          Windows Mobile Hotspot rollback: persistent snapshot; unchanged hotspot PRIVATE role is not bounced\n          Windows Mobile Hotspot fail-closed: ambiguous targets/unrelated PRIVATE ICS/apply verification failure refuse or rollback mutation\n'''
new_build = '''          Windows Mobile Hotspot lifecycle: Windows/user-owned; Karing Start/Stop mutation paths = 0\n          Windows Mobile Hotspot ownership: WinRT/Wi-Fi Direct remains Windows-owned; HNetCfg mutation = 0\n          Windows TUN forwarding-safe mode: physical ForwardingEnabled=true => auto-route route-address limited to final fake-ip CIDR(s); no TUN default route\n          Windows TUN route-mode refresh: stable physical ForwardingEnabled changes trigger runtime regeneration without hotspot Start/Stop\n          Windows HNetCfg legacy compatibility: retained only for legacy Hosted Network; EnableSharing HRESULT/symbol + full error chain retained\n          Windows COM diagnostic: 0x80040201 = EVENT_E_ALL_SUBSCRIBERS_FAILED\n'''
s = replace_once(s, old_build, new_build, 'main workflow BUILD_INFO')
notes = r'''          # Clash Verge Rev Karing ${{ needs.review.outputs.release_tag }}

          `.26` 修复 `.25` 在真实 Windows Mobile Hotspot + Mihomo TUN 并发场景仍会整机断网的问题。现场日志证明故障发生在 HNetCfg 之前：Windows 开启热点后把物理 WLAN `ForwardingEnabled` 置为 true，而 Mihomo 仍使用普通 `auto-route` 默认路由，随后 DNS、DIRECT、代理节点同时超时并出现 `reject loopback connection`。

          - **根因 1：Windows IP forwarding + TUN 默认路由回灌。** `.26` 把物理上游 `ForwardingEnabled` 纳入稳定 Runtime 身份。该状态变化通过 IP Helper 去抖/确认后触发一次受控 Runtime 重生成，不启动/停止热点。
          - **forwarding-safe TUN：** 当物理上游 `ForwardingEnabled=true`，保留 `auto-route` 但用 Mihomo `route-address` 将自动路由限制为最终 DNS 配置里的 `fake-ip-range`（以及启用 IPv6 时的 fake-ip v6 range），不再安装 TUN 全局默认路由。若最终配置不是 fake-ip，则 fail-closed 关闭 `auto-route`，优先保证宿主机不被路由回环黑洞。
          - 这一策略直接对应 Mihomo 官方文档：`route-address` 在 `auto-route` 开启时用指定网段替代默认路由；也对应 Mihomo 2026 年 Windows issue 中“主网卡转发与 TUN 默认路由同时开启会回环”的复现场景。
          - **根因 2：WinRT Mobile Hotspot 不是 HNetCfg PRIVATE 的应用所有对象。** `.25` 新诊断捕获到 `EnableSharing(PRIVATE)` 对 Wi-Fi Direct 返回 `0x80040201`。`.26` 将 Wi-Fi Direct/Mobile Hotspot 明确标记为 `WindowsMobileHotspot`，生产路径对其 HNetCfg mutation 永远为 0；HNetCfg 只保留给 legacy Hosted Network 兼容。
          - `0x80040201` 现在映射为 Windows 标准 `EVENT_E_ALL_SUBSCRIBERS_FAILED`，legacy HNetCfg 失败仍保留十六进制 HRESULT、符号名和完整 error chain。
          - 代理节点与 provider socket 继续绑定稳定物理 WLAN；用户显式 `interface-name` 仍优先；物理 LAN `route-exclude-address` 防护继续保留。
          - `.26` 新增独立 Windows x64/ARM64 gate：真实 `cargo check`、完整 `windows_network_` 单测，并精确证明 forwarding-safe fake-IP-only route、ForwardingEnabled Runtime 身份变化、WinRT Wi-Fi Direct 零 HNetCfg mutation。
          - `.24/.25` 专项 workflow 仍保留用于历史 `workflow_dispatch`/对应修复分支审计，但不再在当前功能分支 push 上用旧语义阻挡后续发行。
          - `.21` IPv6 loopback WFP 修复继续保留，正式 Release 仍要求 12 个安装文件 + `SHA256SUMS.txt` + `BUILD_INFO.txt` 共 14 个公开资产，并由 observer 做同 SHA 与 12/12 SHA256 核验。

          本分支安装包不包含上游官方签名或 Apple 公证，请使用 `SHA256SUMS.txt` 验证下载文件。

          Commit: `${{ needs.review.outputs.commit }}`
'''
s = re.sub(
    r"          # Clash Verge Rev Karing \$\{\{ needs\.review\.outputs\.release_tag \}\}.*?          Commit: `\$\{\{ needs\.review\.outputs\.commit \}\}`\n",
    notes,
    s,
    count=1,
    flags=re.S,
)
s = s.replace('Hotspot Lifecycle Zero-Owner + ICS + IPv6 Loopback WFP', 'Hotspot Forwarding-Safe TUN + Windows Ownership + IPv6 Loopback WFP')
write(path, s)

# Release tag
write('.release/karing-release-tag.txt', 'v2.5.4-karing.26\n')

# Observer: carry same immutable release requirements forward but bind them to v26.
path = '.github/workflows/karing-release-observer.yml'
s = read(path)
s = s.replace('Karing .25 发行核验', 'Karing .26 发行核验')
s = s.replace('v2.5.4-karing.25', 'v2.5.4-karing.26')
s = s.replace('karing25', 'karing26')
s = s.replace('karing-windows-hotspot-v25.yml', 'karing-windows-hotspot-v26.yml')
s = s.replace('Compile v25 network path', 'Compile v26 network path')
s = s.replace('Run v25 lifecycle + ICS + topology regressions', 'Run v26 forwarding-safe + ICS + topology regressions')
s = s.replace('Validate hotspot lifecycle + native ICS invariants', 'Validate hotspot forwarding-safe + ownership invariants')
s = s.replace('Hotspot v25 lifecycle/data-plane run', 'Hotspot v26 forwarding-safe/ownership run')
old_obs = '''          grep -Fqx 'Windows Mobile Hotspot lifecycle: Windows/user-owned; Karing Start/Stop mutation paths = 0' release-audit/BUILD_INFO.txt\n          grep -Fqx 'Windows Mobile Hotspot VPN data plane: native HNetCfg ICS minimal-diff lease; Mihomo TUN=PUBLIC, hotspot=PRIVATE' release-audit/BUILD_INFO.txt\n          grep -Fqx 'Windows Mobile Hotspot ICS apply order: preserve existing PRIVATE; otherwise hotspot PRIVATE before Mihomo PUBLIC' release-audit/BUILD_INFO.txt\n          grep -Fqx 'Windows Mobile Hotspot ICS diagnostics: EnableSharing HRESULT/symbol + full error chain retained' release-audit/BUILD_INFO.txt\n          grep -Fqx 'Windows Mobile Hotspot rollback: persistent snapshot; unchanged hotspot PRIVATE role is not bounced' release-audit/BUILD_INFO.txt\n          grep -Fqx 'Windows Mobile Hotspot fail-closed: ambiguous targets/unrelated PRIVATE ICS/apply verification failure refuse or rollback mutation' release-audit/BUILD_INFO.txt\n'''
new_obs = '''          grep -Fqx 'Windows Mobile Hotspot lifecycle: Windows/user-owned; Karing Start/Stop mutation paths = 0' release-audit/BUILD_INFO.txt\n          grep -Fqx 'Windows Mobile Hotspot ownership: WinRT/Wi-Fi Direct remains Windows-owned; HNetCfg mutation = 0' release-audit/BUILD_INFO.txt\n          grep -Fqx 'Windows TUN forwarding-safe mode: physical ForwardingEnabled=true => auto-route route-address limited to final fake-ip CIDR(s); no TUN default route' release-audit/BUILD_INFO.txt\n          grep -Fqx 'Windows TUN route-mode refresh: stable physical ForwardingEnabled changes trigger runtime regeneration without hotspot Start/Stop' release-audit/BUILD_INFO.txt\n          grep -Fqx 'Windows HNetCfg legacy compatibility: retained only for legacy Hosted Network; EnableSharing HRESULT/symbol + full error chain retained' release-audit/BUILD_INFO.txt\n          grep -Fqx 'Windows COM diagnostic: 0x80040201 = EVENT_E_ALL_SUBSCRIBERS_FAILED' release-audit/BUILD_INFO.txt\n'''
s = replace_once(s, old_obs, new_obs, 'observer BUILD_INFO checks')
s = s.replace('- VPN sharing data plane: **native HNetCfg ICS minimal-diff · Mihomo TUN PUBLIC -> Hotspot PRIVATE**', '- Mobile Hotspot ownership: **WinRT/Wi-Fi Direct Windows-owned · HNetCfg mutation 0**\n          - TUN routing: **ForwardingEnabled -> fake-IP-only route-address · no TUN default route**')
s = s.replace('- rollback: **unchanged hotspot PRIVATE preserved; persistent snapshot verified**', '- legacy HNetCfg: **Hosted Network only · persistent rollback + HRESULT diagnostics retained**')
write(path, s)

# v25/v24 comments remain historical; main and observer now certify v26.

# Sanity checks before rustfmt.
required = {
    'src-tauri/src/utils/windows_network.rs': [
        'apply_forwarding_safe_tun_route', 'forwarding_enabled: bool',
        'windows_network_forwarding_safe_tun_routes_only_fake_ip_range',
    ],
    'src-tauri/src/core/windows_network_diagnostics.rs': [
        'physical-forwarding-mode-changed', 'forwarding_state_changed',
        '"hotspot_events_can_trigger_core_refresh": "forwarding-mode-only"',
    ],
    'src-tauri/src/core/windows_hotspot_ics.rs': [
        'windows-owned-hotspot-no-hnetcfg-mutation', 'EVENT_E_ALL_SUBSCRIBERS_FAILED',
        'WindowsMobileHotspot',
    ],
    '.github/workflows/karing-diagnostics-once.yml': ['zero-owner-v26', 'forwarding-safe-fake-ip-only'],
    '.github/workflows/karing-release-observer.yml': ['v2.5.4-karing.26', 'karing-windows-hotspot-v26.yml'],
}
for path, markers in required.items():
    text = read(path)
    for marker in markers:
        if marker not in text:
            raise SystemExit(f'{path}: missing final marker {marker}')

print('karing.26 forwarding-safe repair applied')
