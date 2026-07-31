mod country;
mod matcher;

use serde_yaml_ng::{Mapping, Sequence, Value};

const CONFIG_KEY: &str = "x-karing-diversion";
const CONFIG_KEY_ALT: &str = "x_karing_diversion";
const BUILTIN_GROUPS_KEY: &str = "x-karing-diversion-builtins";
const BUILTIN_GROUPS_KEY_ALT: &str = "x_karing_diversion_builtins";

pub(super) fn prepare(config: &mut Mapping) {
    let provider_names = config
        .get("rule-providers")
        .and_then(Value::as_mapping)
        .map(|providers| {
            providers
                .keys()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // Keep built-in selections outside the manager-owned object so an older
    // manager UI preserves them. Merge them only while producing Mihomo config.
    let builtin_groups = match config
        .remove(BUILTIN_GROUPS_KEY)
        .or_else(|| config.remove(BUILTIN_GROUPS_KEY_ALT))
    {
        Some(Value::Sequence(groups)) => groups,
        _ => Sequence::new(),
    };
    let has_active_builtin = builtin_groups.iter().any(is_active_group);

    let key = if config.contains_key(CONFIG_KEY) {
        CONFIG_KEY
    } else if config.contains_key(CONFIG_KEY_ALT) {
        CONFIG_KEY_ALT
    } else if !has_active_builtin {
        return;
    } else {
        let mut diversion = Mapping::new();
        diversion.insert(Value::from("enabled"), Value::from(true));
        diversion.insert(Value::from("groups"), Value::Sequence(Sequence::new()));
        config.insert(Value::from(CONFIG_KEY), Value::Mapping(diversion));
        CONFIG_KEY
    };

    let Some(Value::Mapping(diversion)) = config.get_mut(key) else {
        return;
    };

    // Standalone built-in selections still activate older configs that do not
    // contain an explicit global switch. An explicit `enabled: false` is always
    // authoritative, so the simple UI can reliably turn all diversion off.
    if has_active_builtin && diversion.get("enabled").and_then(Value::as_bool).is_none() {
        diversion.insert(Value::from("enabled"), Value::from(true));
    }

    country::inject(diversion);

    let groups = diversion
        .entry(Value::from("groups"))
        .or_insert_with(|| Value::Sequence(Sequence::new()));
    let Some(groups) = groups.as_sequence_mut() else {
        return;
    };
    groups.extend(builtin_groups);

    for group in groups {
        let Some(group) = group.as_mapping_mut() else {
            continue;
        };
        let Some(matchers) = group.get_mut("matchers").and_then(Value::as_sequence_mut) else {
            continue;
        };

        for value in matchers {
            matcher::normalize(value, &provider_names);
        }
    }
}

fn is_active_group(value: &Value) -> bool {
    let Some(group) = value.as_mapping() else {
        return false;
    };
    if group.get("enabled").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    if group
        .get("action")
        .and_then(Value::as_str)
        .is_some_and(|action| action.eq_ignore_ascii_case("none"))
    {
        return false;
    }

    group
        .get("matchers")
        .and_then(Value::as_sequence)
        .is_some_and(|matchers| matchers.iter().any(is_active_matcher))
}

fn is_active_matcher(value: &Value) -> bool {
    let Some(matcher) = value.as_mapping() else {
        return false;
    };
    if matcher.get("enabled").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    if matcher
        .get("type")
        .and_then(Value::as_str)
        .is_none_or(|rule_type| !rule_type.eq_ignore_ascii_case("RULE-SET-BUILDIN"))
    {
        return false;
    }

    matcher
        .get("value")
        .and_then(Value::as_str)
        .map(str::trim)
        .and_then(|raw| raw.split_once(':'))
        .is_some_and(|(kind, name)| {
            matches!(
                kind.trim().to_ascii_lowercase().as_str(),
                "geosite" | "geoip" | "acl"
            ) && !name.trim().is_empty()
        })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used)]
    use super::*;

    fn mapping(yaml: &str) -> Mapping {
        serde_yaml_ng::from_str(yaml).expect("test yaml should be valid")
    }

    #[test]
    fn disabled_builtins_do_not_activate_diversion() {
        let mut config = mapping(
            r"
x-karing-diversion-builtins:
  - name: 中国大陆直连
    enabled: false
    action: direct
    matchers:
      - enabled: true
        type: RULE-SET-BUILDIN
        value: geosite:cn
",
        );

        prepare(&mut config);

        assert!(!config.contains_key(CONFIG_KEY));
        assert!(!config.contains_key(BUILTIN_GROUPS_KEY));
    }

    #[test]
    fn invalid_or_disabled_matchers_do_not_activate_diversion() {
        let mut config = mapping(
            r"
x-karing-diversion-builtins:
  - name: 无效规则
    enabled: true
    action: direct
    matchers:
      - enabled: true
        type: RULE-SET-BUILDIN
        value: geosite:
      - enabled: false
        type: RULE-SET-BUILDIN
        value: geoip:cn
",
        );

        prepare(&mut config);

        assert!(!config.contains_key(CONFIG_KEY));
        assert!(!config.contains_key(BUILTIN_GROUPS_KEY));
    }

    #[test]
    fn active_builtin_creates_and_normalizes_diversion() {
        let mut config = mapping(
            r"
x-karing-diversion-builtins:
  - name: 中国大陆直连
    enabled: true
    action: direct
    matchers:
      - enabled: true
        type: RULE-SET-BUILDIN
        value: geosite:cn
      - enabled: true
        type: RULE-SET-BUILDIN
        value: geoip:cn
",
        );

        prepare(&mut config);

        let diversion = config
            .get(CONFIG_KEY)
            .and_then(Value::as_mapping)
            .expect("diversion config should be created");
        assert_eq!(
            diversion.get("enabled").and_then(Value::as_bool),
            Some(true)
        );

        let groups = diversion
            .get("groups")
            .and_then(Value::as_sequence)
            .expect("groups should exist");
        let matchers = groups[0]
            .as_mapping()
            .and_then(|group| group.get("matchers"))
            .and_then(Value::as_sequence)
            .expect("matchers should exist");

        let geosite = matchers[0].as_mapping().expect("geosite matcher");
        assert_eq!(
            geosite.get("type").and_then(Value::as_str),
            Some("GEOSITE")
        );
        assert_eq!(
            geosite.get("value").and_then(Value::as_str),
            Some("cn")
        );
        assert_eq!(
            geosite.get("no-resolve").and_then(Value::as_bool),
            Some(false)
        );

        let geoip = matchers[1].as_mapping().expect("geoip matcher");
        assert_eq!(geoip.get("type").and_then(Value::as_str), Some("GEOIP"));
        assert_eq!(geoip.get("value").and_then(Value::as_str), Some("CN"));
        assert_eq!(
            geoip.get("no-resolve").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn explicit_global_disable_wins_over_active_builtin() {
        let mut config = mapping(
            r"
x-karing-diversion:
  enabled: false
  groups: []
x-karing-diversion-builtins:
  - name: 广告拦截
    enabled: true
    action: reject
    matchers:
      - enabled: true
        type: RULE-SET-BUILDIN
        value: geosite:category-ads-all
",
        );

        prepare(&mut config);

        let diversion = config
            .get(CONFIG_KEY)
            .and_then(Value::as_mapping)
            .expect("diversion config should remain available");
        assert_eq!(
            diversion.get("enabled").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            diversion
                .get("groups")
                .and_then(Value::as_sequence)
                .map(Sequence::len),
            Some(1)
        );
    }
}
