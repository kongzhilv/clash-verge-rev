use serde_yaml_ng::{Mapping, Value};

const CONFIG_KEY: &str = "x-karing-diversion";
const CONFIG_KEY_ALT: &str = "x_karing_diversion";
const CURRENT_GROUP_DEFAULT: &str = "CVR-当前选择";
const AUTO_GROUP_DEFAULT: &str = "CVR-自动选择";

#[derive(Debug, Clone)]
pub(super) struct ManagedGroupNames {
    current: String,
    auto: String,
}

pub(super) fn capture(config: &Mapping) -> Option<ManagedGroupNames> {
    let diversion = config
        .get(CONFIG_KEY)
        .or_else(|| config.get(CONFIG_KEY_ALT))?
        .as_mapping()?;

    if !diversion.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }

    Some(ManagedGroupNames {
        current: string_value(diversion, "current-group-name")
            .unwrap_or(CURRENT_GROUP_DEFAULT)
            .trim()
            .to_owned(),
        auto: string_value(diversion, "auto-group-name")
            .unwrap_or(AUTO_GROUP_DEFAULT)
            .trim()
            .to_owned(),
    })
}

pub(super) fn cleanup(config: &mut Mapping, names: Option<&ManagedGroupNames>) {
    let Some(names) = names else {
        return;
    };

    let auto_is_used = config.get("rules").and_then(Value::as_sequence).is_some_and(|rules| {
        rules
            .iter()
            .any(|rule| rule.as_str().is_some_and(|raw| rule_targets_policy(raw, &names.auto)))
    });

    if auto_is_used {
        return;
    }

    let Some(groups) = config.get_mut("proxy-groups").and_then(Value::as_sequence_mut) else {
        return;
    };

    groups.retain(|group| group_name(group) != Some(names.auto.as_str()));

    for group in groups.iter_mut() {
        let Some(mapping) = group.as_mapping_mut() else {
            continue;
        };
        if mapping.get("name").and_then(Value::as_str) != Some(names.current.as_str()) {
            continue;
        }
        if let Some(proxies) = mapping.get_mut("proxies").and_then(Value::as_sequence_mut) {
            proxies.retain(|proxy| proxy.as_str() != Some(names.auto.as_str()));
        }
    }
}

fn group_name(group: &Value) -> Option<&str> {
    group
        .as_mapping()
        .and_then(|mapping| mapping.get("name"))
        .and_then(Value::as_str)
}

fn rule_targets_policy(raw: &str, policy: &str) -> bool {
    let parts = raw.split(',').map(str::trim).collect::<Vec<_>>();
    if parts.len() < 2 {
        return false;
    }

    let policy_index = if parts.last().is_some_and(|part| part.eq_ignore_ascii_case("no-resolve")) {
        parts.len() - 2
    } else {
        parts.len() - 1
    };

    parts[policy_index].eq_ignore_ascii_case(policy)
}

fn string_value<'a>(mapping: &'a Mapping, key: &str) -> Option<&'a str> {
    mapping.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapping(yaml: &str) -> Mapping {
        serde_yaml_ng::from_str(yaml).expect("test yaml should be valid")
    }

    #[test]
    fn removes_unreferenced_auto_group() {
        let mut config = mapping(
            r#"
rules:
  - DOMAIN-SUFFIX,openai.com,CVR-当前选择
  - MATCH,CVR-当前选择
proxy-groups:
  - name: CVR-当前选择
    type: select
    proxies: [CVR-自动选择, DIRECT]
  - name: CVR-自动选择
    type: url-test
    include-all: true
"#,
        );
        let names = ManagedGroupNames {
            current: CURRENT_GROUP_DEFAULT.to_owned(),
            auto: AUTO_GROUP_DEFAULT.to_owned(),
        };

        cleanup(&mut config, Some(&names));

        let groups = config
            .get("proxy-groups")
            .and_then(Value::as_sequence)
            .expect("proxy groups");
        assert_eq!(groups.len(), 1);
        let current = groups[0].as_mapping().expect("current group");
        let proxies = current
            .get("proxies")
            .and_then(Value::as_sequence)
            .expect("current proxies");
        assert_eq!(proxies, &vec![Value::from("DIRECT")]);
    }

    #[test]
    fn keeps_referenced_auto_group() {
        let mut config = mapping(
            r#"
rules:
  - DOMAIN-SUFFIX,openai.com,CVR-自动选择
  - MATCH,CVR-当前选择
proxy-groups:
  - name: CVR-当前选择
    type: select
    proxies: [CVR-自动选择, DIRECT]
  - name: CVR-自动选择
    type: url-test
    include-all: true
"#,
        );
        let names = ManagedGroupNames {
            current: CURRENT_GROUP_DEFAULT.to_owned(),
            auto: AUTO_GROUP_DEFAULT.to_owned(),
        };

        cleanup(&mut config, Some(&names));

        let groups = config
            .get("proxy-groups")
            .and_then(Value::as_sequence)
            .expect("proxy groups");
        assert_eq!(groups.len(), 2);
    }
}
