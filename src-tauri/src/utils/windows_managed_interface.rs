use serde_yaml_ng::{Mapping, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedPhysicalInterfaceLease {
    pub applied: bool,
    pub interface_alias: String,
    pub auto_detect_interface: Option<bool>,
}

pub fn apply_managed_physical_interface_lease(
    config: &mut Mapping,
    interface_alias: &str,
) -> ManagedPhysicalInterfaceLease {
    let alias = interface_alias.trim();
    if alias.is_empty() {
        return ManagedPhysicalInterfaceLease {
            applied: false,
            interface_alias: String::new(),
            auto_detect_interface: config
                .get("tun")
                .and_then(Value::as_mapping)
                .and_then(|tun| tun.get("auto-detect-interface"))
                .and_then(Value::as_bool),
        };
    }

    let interface_key = Value::from("interface-name");
    let explicit = config
        .get(&interface_key)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    if explicit {
        return ManagedPhysicalInterfaceLease {
            applied: false,
            interface_alias: config
                .get(&interface_key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            auto_detect_interface: config
                .get("tun")
                .and_then(Value::as_mapping)
                .and_then(|tun| tun.get("auto-detect-interface"))
                .and_then(Value::as_bool),
        };
    }

    config.insert(interface_key, Value::from(alias));

    let mut auto_detect_interface = None;
    if let Some(Value::Mapping(tun)) = config.get_mut("tun") {
        // The application-level topology watcher now owns upstream selection. Keeping
        // Mihomo auto-detect enabled at the same time creates two independent selectors
        // during Wi-Fi + Wi-Fi Direct/ICS transitions and can re-open a routing loop.
        tun.insert(Value::from("auto-detect-interface"), Value::from(false));
        auto_detect_interface = Some(false);
    }

    ManagedPhysicalInterfaceLease {
        applied: true,
        interface_alias: alias.to_owned(),
        auto_detect_interface,
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod tests {
    use super::apply_managed_physical_interface_lease;
    use serde_yaml_ng::{Mapping, Value};

    fn mapping(yaml: &str) -> Mapping {
        serde_yaml_ng::from_str(yaml).expect("test config should be valid")
    }

    #[test]
    fn managed_lease_binds_all_outbound_to_stable_physical_nic() {
        let mut config = mapping("{tun: {enable: true, auto-route: true, auto-detect-interface: true}}");
        let lease = apply_managed_physical_interface_lease(&mut config, "WLAN");

        assert!(lease.applied);
        assert_eq!(lease.interface_alias, "WLAN");
        assert_eq!(lease.auto_detect_interface, Some(false));
        assert_eq!(config.get("interface-name").and_then(Value::as_str), Some("WLAN"));
        assert_eq!(
            config
                .get("tun")
                .and_then(Value::as_mapping)
                .and_then(|tun| tun.get("auto-detect-interface"))
                .and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn explicit_user_interface_is_never_overwritten() {
        let mut config = mapping(
            "{interface-name: Ethernet, tun: {enable: true, auto-route: true, auto-detect-interface: true}}",
        );
        let lease = apply_managed_physical_interface_lease(&mut config, "WLAN");

        assert!(!lease.applied);
        assert_eq!(lease.interface_alias, "Ethernet");
        assert_eq!(config.get("interface-name").and_then(Value::as_str), Some("Ethernet"));
        assert_eq!(
            config
                .get("tun")
                .and_then(Value::as_mapping)
                .and_then(|tun| tun.get("auto-detect-interface"))
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn empty_detected_alias_does_not_create_a_broken_lease() {
        let mut config = mapping("{tun: {enable: true, auto-route: true, auto-detect-interface: true}}");
        let lease = apply_managed_physical_interface_lease(&mut config, "   ");

        assert!(!lease.applied);
        assert!(config.get("interface-name").is_none());
        assert_eq!(lease.auto_detect_interface, Some(true));
    }
}
