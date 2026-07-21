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

    // Keep built-in selections outside the main manager-owned object so older
    // frontends preserve them. They are merged into groups only for compilation.
    let builtin_groups = match config
        .remove(BUILTIN_GROUPS_KEY)
        .or_else(|| config.remove(BUILTIN_GROUPS_KEY_ALT))
    {
        Some(Value::Sequence(groups)) => groups,
        _ => Sequence::new(),
    };

    let key = if config.contains_key(CONFIG_KEY) {
        CONFIG_KEY
    } else if config.contains_key(CONFIG_KEY_ALT) {
        CONFIG_KEY_ALT
    } else {
        return;
    };

    let Some(Value::Mapping(diversion)) = config.get_mut(key) else {
        return;
    };

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
