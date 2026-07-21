mod diversion;
mod diversion_builtin;
mod diversion_managed;

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

pub fn use_sort(mut config: Mapping) -> Mapping {
    // Normalize app-only Karing matcher types and merge built-in groups first,
    // so managed group names can also be captured for built-in-only configs.
    diversion_builtin::prepare(&mut config);
    let managed_groups = diversion_managed::capture(&config);
    diversion::apply(&mut config);
    diversion_managed::cleanup(&mut config, managed_groups.as_ref());

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
    use super::*;

    fn mapping(yaml: &str) -> Mapping {
        serde_yaml_ng::from_str(yaml).expect("test yaml should be valid")
    }

    #[test]
    fn builtin_only_config_compiles_and_removes_unused_auto_group() {
        let config = mapping(
            r#"
x-karing-diversion-builtins:
  - name: 中国大陆直连
    enabled: true
    action: direct
    matchers:
      - enabled: true
        type: RULE-SET-BUILDIN
        value: geosite:cn
"#,
        );

        let sorted = use_sort(config);
        let rules = sorted
            .get("rules")
            .and_then(Value::as_sequence)
            .expect("compiled rules should exist");
        assert!(rules.iter().any(|rule| rule.as_str() == Some("GEOSITE,cn,DIRECT")));

        let groups = sorted
            .get("proxy-groups")
            .and_then(Value::as_sequence)
            .expect("current selection group should exist");
        assert!(groups.iter().all(|group| {
            group
                .as_mapping()
                .and_then(|mapping| mapping.get("name"))
                .and_then(Value::as_str)
                != Some("CVR-自动选择")
        }));
    }
}
