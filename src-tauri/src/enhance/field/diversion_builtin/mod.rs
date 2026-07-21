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

    // Enabling an independent built-in group should make it effective even if
    // the general diversion editor was previously disabled.
    if has_active_builtin {
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
        .is_some_and(|matchers| !matchers.is_empty())
}
