use std::sync::{
    OnceLock,
    atomic::{AtomicBool, Ordering},
};

use anyhow::Result;
use serde_json::json;

use crate::core::diagnostics;

static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);
static ZERO_OWNER_LOGGED: OnceLock<()> = OnceLock::new();
const HOTSPOT_LIFECYCLE_POLICY: &str = "zero-hotspot-lifecycle-owner";
const HOTSPOT_SHUTDOWN_POLICY: &str = "leave-hotspot-unchanged";

/// Karing v24 intentionally owns **zero** Mobile Hotspot lifecycle operations.
///
/// Windows and the user remain the only authority for turning Mobile Hotspot on
/// or off. Hotspot/Wi-Fi Direct topology is observed by
/// `windows_network_diagnostics`; this compatibility module performs no hotspot,
/// service, adapter, route, NAT, or forwarding mutation.
pub fn ensure_monitor_running() {
    if MONITOR_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }

    let _ = ZERO_OWNER_LOGGED.set(());
    diagnostics::info(
        "windows-hotspot-zero-owner",
        "lifecycle-unowned",
        json!({
            "policy": HOTSPOT_LIFECYCLE_POLICY,
            "hotspot_lifecycle_mutation": false,
            "hotspot_start_stop": "windows-or-user-only",
            "topology_observer": "windows-network-diagnostics",
            "vpn_data_plane": "mihomo-tun-routing",
            "physical_forwarding_mutation": false,
            "global_ip_forwarding_mutation": false,
            "polling_reconcile": false,
            "persistent_hotspot_lease": false,
        }),
    );
}

/// Compatibility hook for the existing shutdown path.
///
/// Older builds restored a rebound tethering lease here. v24 never creates such
/// a lease, so shutdown must leave Mobile Hotspot exactly as the user left it.
pub async fn restore_now(reason: &'static str) -> Result<bool> {
    diagnostics::info(
        "windows-hotspot-zero-owner",
        "restore-skipped-no-ownership",
        json!({
            "reason": reason,
            "restored": false,
            "hotspot_lifecycle_mutation": false,
            "policy": HOTSPOT_SHUTDOWN_POLICY,
        }),
    );
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::{HOTSPOT_LIFECYCLE_POLICY, HOTSPOT_SHUTDOWN_POLICY};

    #[test]
    fn windows_hotspot_zero_owner_contract_is_explicit() {
        assert_eq!(HOTSPOT_LIFECYCLE_POLICY, "zero-hotspot-lifecycle-owner");
        assert_eq!(HOTSPOT_SHUTDOWN_POLICY, "leave-hotspot-unchanged");
    }
}
