mod diversion;
mod diversion_builtin;
mod diversion_managed;

use clash_verge_logging::{Type, logging};
use serde_yaml_ng::{Mapping, Value};
use smartstring::alias::String;

pub const HANDLE_FIELDS: [&str; 12] = [
    "mode",
    "redir-port",
    "tproxy-port",
    "mixed-port",
    "socks-port",
    "port",
    "allow-lan",
    "log-level",
    "ipv6",
    "external-controller",
    "secret",
    "unified-delay",
];

pub const DEFAULT_FIELDS: [&str; 5] = ["proxies", "proxy-providers", "proxy-groups", "rule-providers", "rules"];

fn lowercase_key(key: &str) -> Value {
    let mut key = String::from(key);
    key.make_ascii_lowercase();
    Value::from(key.as_str())
}

pub fn use_lowercase(config: &Mapping) -> Mapping {
    let mut lowercased = Mapping::new();

    for (key, value) in config {
        if let Some(key_str) = key.as_str() {
            lowercased.insert(lowercase_key(key_str), value.clone());
        }
    }
    lowercased
}

pub fn use_lowercase_owned(config: Mapping) -> Mapping {
    let mut lowercased = Mapping::new();

    for (key, value) in config {
        if let Some(key_str) = key.as_str() {
            lowercased.insert(lowercase_key(key_str), value);
        }
    }
    lowercased
}

fn ensure_desktop_process_discovery(config: &mut Mapping) {
    if !config.contains_key("find-process-mode") {
        config.insert("find-process-mode".into(), "strict".into());
        logging!(
            info,
            Type::Config,
            "defaulted find-process-mode to strict for desktop connection metadata"
        );
    }
}

fn sanitize_removed_options(config: &mut Mapping) {
    if config.remove("global-client-fingerprint").is_some() {
        logging!(
            warn,
            Type::Config,
            "removed unsupported global-client-fingerprint from generated Mihomo config"
        );
    }
}

fn secure_known_health_check_url(url: &str) -> Option<std::string::String> {
    let trimmed = url.trim();
    let lowercase = trimmed.to_ascii_lowercase();
    let known_http_url = lowercase == "http://www.gstatic.com"
        || lowercase.starts_with("http://www.gstatic.com/")
        || lowercase == "http://cp.cloudflare.com"
        || lowercase.starts_with("http://cp.cloudflare.com/");

    known_http_url.then(|| format!("https://{}", &trimmed["http://".len()..]))
}

fn secure_mapping_url(mapping: &mut Mapping, key: &str) -> bool {
    let Some(Value::String(url)) = mapping.get_mut(key) else {
        return false;
    };
    let Some(secure_url) = secure_known_health_check_url(url) else {
        return false;
    };

    *url = secure_url;
    true
}

fn normalize_known_health_check_urls(config: &mut Mapping) {
    let mut updated = 0usize;

    if let Some(Value::Sequence(groups)) = config.get_mut("proxy-groups") {
        for group in groups {
            if let Some(group) = group.as_mapping_mut()
                && secure_mapping_url(group, "url")
            {
                updated += 1;
            }
        }
    }

    if let Some(Value::Mapping(providers)) = config.get_mut("proxy-providers") {
        for (_, provider) in providers.iter_mut() {
            if let Some(provider) = provider.as_mapping_mut()
                && let Some(Value::Mapping(health_check)) = provider.get_mut("health-check")
                && secure_mapping_url(health_check, "url")
            {
                updated += 1;
            }
        }
    }

    if updated > 0 {
        logging!(
            info,
            Type::Config,
            "upgraded {updated} known health-check URL(s) from HTTP to HTTPS"
        );
    }
}

pub fn use_sort(mut config: Mapping) -> Mapping {
    diversion_builtin::prepare(&mut config);
    let managed_groups = diversion_managed::capture(&config);
    diversion::apply(&mut config);
    diversion_managed::cleanup(&mut config, managed_groups.as_ref());
    ensure_desktop_process_discovery(&mut config);
    sanitize_removed_options(&mut config);
    normalize_known_health_check_urls(&mut config);

    let mut sorted = Mapping::new();
    HANDLE_FIELDS.into_iter().for_each(|key| {
        let key = Value::from(key);
        if let Some(value) = config.remove(&key) {
            sorted.insert(key, value);
        }
    });

    let mut default_field_values = Mapping::new();
    for (key, value) in config {
        if let Some(key_str) = key.as_str() {
            if DEFAULT_FIELDS.contains(&key_str) {
                default_field_values.insert(key, value);
            } else if !HANDLE_FIELDS.contains(&key_str) {
                sorted.insert(key, value);
            }
        }
    }

    DEFAULT_FIELDS.into_iter().for_each(|key| {
        let key = Value::from(key);
        if let Some(value) = default_field_values.remove(&key) {
            sorted.insert(key, value);
        }
    });

    sorted
}

#[inline]
pub fn use_keys<'a>(config: &'a Mapping) -> impl Iterator<Item = String> + 'a {
    config.iter().filter_map(|(key, _)| key.as_str()).map(|s: &str| {
        let mut s: String = s.into();
        s.make_ascii_lowercase();
        s
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used)]
    use super::*;

    fn mapping(yaml: &str) -> Mapping {
        serde_yaml_ng::from_str(yaml).expect("test yaml should be valid")
    }

    fn group_names(config: &Mapping) -> Vec<&str> {
        config
            .get("proxy-groups")
            .and_then(Value::as_sequence)
            .into_iter()
            .flatten()
            .filter_map(Value::as_mapping)
            .filter_map(|group| group.get("name"))
            .filter_map(Value::as_str)
            .collect()
    }

    #[test]
    fn builtin_only_config_compiles_and_removes_unused_auto_group() {
        let config = mapping(
            r"
x-karing-diversion-builtins:
  - name: 中国大陆直连
    enabled: true
    action: direct
    matchers:
      - enabled: true
        type: RULE-SET-BUILDIN
        value: geosite:cn
",
        );

        let sorted = use_sort(config);
        let rules = sorted
            .get("rules")
            .and_then(Value::as_sequence)
            .expect("compiled rules should exist");
        assert!(rules.iter().any(|rule| rule.as_str() == Some("GEOSITE,cn,DIRECT")));
        assert!(!group_names(&sorted).contains(&"CVR-自动选择"));
    }

    #[test]
    fn current_only_config_does_not_leave_auto_group() {
        let config = mapping(
            r"
x-karing-diversion:
  enabled: true
  private-network-direct: false
  fallback: current
  groups:
    - name: AI
      enabled: true
      action: current
      matchers:
        - enabled: true
          type: DOMAIN-SUFFIX
          value: openai.com
",
        );

        let sorted = use_sort(config);
        let names = group_names(&sorted);
        assert!(names.contains(&"CVR-当前选择"));
        assert!(!names.contains(&"CVR-自动选择"));
    }

    #[test]
    fn auto_action_keeps_url_test_group() {
        let config = mapping(
            r"
x-karing-diversion:
  enabled: true
  private-network-direct: false
  fallback: direct
  groups:
    - name: AI
      enabled: true
      action: auto-select
      matchers:
        - enabled: true
          type: DOMAIN-SUFFIX
          value: openai.com
",
        );

        let sorted = use_sort(config);
        assert!(group_names(&sorted).contains(&"CVR-自动选择"));
    }

    #[test]
    fn ordinary_rule_set_does_not_append_no_resolve() {
        let config = mapping(
            r"
x-karing-diversion:
  enabled: true
  private-network-direct: false
  fallback: direct
  groups:
    - name: Remote
      enabled: true
      action: direct
      matchers:
        - enabled: true
          type: RULE-SET
          value: remote-rules
",
        );

        let sorted = use_sort(config);
        let rules = sorted
            .get("rules")
            .and_then(Value::as_sequence)
            .expect("compiled rules should exist");
        assert!(
            rules
                .iter()
                .any(|rule| rule.as_str() == Some("RULE-SET,remote-rules,DIRECT"))
        );
    }

    #[test]
    fn missing_process_mode_defaults_to_strict() {
        let sorted = use_sort(Mapping::new());
        assert_eq!(sorted.get("find-process-mode").and_then(Value::as_str), Some("strict"));
    }

    #[test]
    fn explicit_process_mode_is_preserved() {
        let sorted = use_sort(mapping("find-process-mode: off"));
        assert_eq!(sorted.get("find-process-mode").and_then(Value::as_str), Some("off"));
    }

    #[test]
    fn removed_global_client_fingerprint_is_not_emitted() {
        let sorted = use_sort(mapping("global-client-fingerprint: chrome"));
        assert!(!sorted.contains_key("global-client-fingerprint"));
    }

    #[test]
    fn known_http_health_checks_are_upgraded_to_https() {
        let sorted = use_sort(mapping(
            r"
proxy-groups:
  - name: Auto
    type: url-test
    url: http://www.gstatic.com/generate_204
  - name: Custom
    type: url-test
    url: http://example.com/generate_204
proxy-providers:
  provider:
    type: http
    url: https://example.com/subscription.yaml
    health-check:
      enable: true
      url: http://cp.cloudflare.com/generate_204
",
        ));

        let groups = sorted
            .get("proxy-groups")
            .and_then(Value::as_sequence)
            .expect("groups should exist");
        assert_eq!(
            groups[0].get("url").and_then(Value::as_str),
            Some("https://www.gstatic.com/generate_204")
        );
        assert_eq!(
            groups[1].get("url").and_then(Value::as_str),
            Some("http://example.com/generate_204")
        );

        let provider_url = sorted
            .get("proxy-providers")
            .and_then(Value::as_mapping)
            .and_then(|providers| providers.get("provider"))
            .and_then(Value::as_mapping)
            .and_then(|provider| provider.get("health-check"))
            .and_then(Value::as_mapping)
            .and_then(|health_check| health_check.get("url"))
            .and_then(Value::as_str);
        assert_eq!(provider_url, Some("https://cp.cloudflare.com/generate_204"));
    }
}
