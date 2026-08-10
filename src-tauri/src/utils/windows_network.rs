use anyhow::{Result, anyhow};
use serde::Deserialize;
use serde_yaml_ng::{Mapping, Value};
use std::os::windows::process::CommandExt as _;
use std::process::Command;
use std::thread;
use std::time::Duration;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const STABLE_SAMPLES: usize = 6;
const MAX_SAMPLES: usize = 24;
const SAMPLE_DELAY: Duration = Duration::from_millis(500);

const POWERSHELL_ROUTE_QUERY: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$routes = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -PolicyStore ActiveStore -ErrorAction Stop |
  Where-Object { $_.State -eq 'Alive' -and $_.NextHop -and $_.NextHop -ne '0.0.0.0' }

$candidates = foreach ($route in $routes) {
  $adapter = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue
  if ($null -eq $adapter -or $adapter.Status -ne 'Up') { continue }

  $identity = "$($adapter.Name) $($adapter.InterfaceDescription)"
  if ($identity -match '(?i)(mihomo|clash|wi-?fi direct virtual adapter|mobile hotspot|hyper-v|vmware|virtualbox|wintun|wireguard|tailscale|zerotier|\btap\b)') { continue }

  $address = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.AddressState -eq 'Preferred' -and
      $_.IPAddress -notlike '169.254.*' -and
      $_.IPAddress -ne '127.0.0.1'
    } |
    Select-Object -First 1
  if ($null -eq $address) { continue }

  $ipInterface = Get-NetIPInterface -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue
  if ($null -eq $ipInterface -or $ipInterface.ConnectionState -ne 'Connected') { continue }

  [PSCustomObject]@{
    InterfaceIndex = [int]$route.InterfaceIndex
    InterfaceAlias = [string]$adapter.Name
    InterfaceDescription = [string]$adapter.InterfaceDescription
    SourceAddress = [string]$address.IPAddress
    Gateway = [string]$route.NextHop
    RouteMetric = [int]$route.RouteMetric
    InterfaceMetric = [int]$ipInterface.InterfaceMetric
    EffectiveMetric = [int]$route.RouteMetric + [int]$ipInterface.InterfaceMetric
  }
}

$best = $candidates |
  Sort-Object EffectiveMetric, RouteMetric, InterfaceMetric, InterfaceIndex |
  Select-Object -First 1

if ($null -eq $best) {
  Write-Error 'No stable physical IPv4 default route is available.'
  exit 2
}

$best | ConvertTo-Json -Compress
"#;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct WindowsUpstreamRoute {
    pub interface_index: u32,
    pub interface_alias: String,
    pub interface_description: String,
    pub source_address: String,
    pub gateway: String,
    pub route_metric: u32,
    pub interface_metric: u32,
    pub effective_metric: u32,
}

impl WindowsUpstreamRoute {
    fn signature(&self) -> String {
        format!(
            "{}|{}|{}",
            self.interface_index, self.source_address, self.gateway
        )
    }
}

fn query_upstream_route() -> Result<WindowsUpstreamRoute> {
    let output = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            POWERSHELL_ROUTE_QUERY,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| anyhow!("failed to inspect Windows default route: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "Windows default-route inspection failed: {}",
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim())
        .map_err(|error| anyhow!("failed to parse Windows default route: {error}"))
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
            "Windows default route did not stay stable long enough (last: {} / {} / {})",
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

pub fn apply_managed_upstream(config: &mut Mapping, route: &WindowsUpstreamRoute) {
    config.insert(
        Value::from("interface-name"),
        Value::from(route.interface_alias.as_str()),
    );

    if let Some(Value::Mapping(tun)) = config.get_mut("tun") {
        tun.insert(Value::from("auto-detect-interface"), Value::from(false));
    }
}

#[cfg(test)]
mod tests {
    use super::{WindowsUpstreamRoute, apply_managed_upstream, tun_needs_managed_upstream};
    use serde_yaml_ng::Mapping;

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
    fn managed_upstream_pins_runtime_interface_and_disables_autodetect() {
        let mut config = mapping("{tun: {enable: true, auto-route: true, auto-detect-interface: true}}");
        apply_managed_upstream(&mut config, &route());

        assert_eq!(
            config.get("interface-name").and_then(serde_yaml_ng::Value::as_str),
            Some("WLAN")
        );
        assert_eq!(
            config
                .get("tun")
                .and_then(serde_yaml_ng::Value::as_mapping)
                .and_then(|tun| tun.get("auto-detect-interface"))
                .and_then(serde_yaml_ng::Value::as_bool),
            Some(false)
        );
    }
}
