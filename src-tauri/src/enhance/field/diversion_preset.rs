use clash_verge_logging::{Type, logging};
use serde_yaml_ng::{Mapping, Sequence, Value};

const CONFIG_KEY: &str = "x-karing-diversion";
const CONFIG_KEY_ALT: &str = "x_karing_diversion";
const BUILTIN_TYPE: &str = "RULE-SET-BUILDIN";

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

    let config_key = if config.contains_key(CONFIG_KEY) {
        CONFIG_KEY
    } else if config.contains_key(CONFIG_KEY_ALT) {
        CONFIG_KEY_ALT
    } else {
        return;
    };

    let Some(Value::Mapping(diversion)) = config.get_mut(config_key) else {
        return;
    };

    inject_country_rules(diversion);

    let Some(groups) = diversion.get_mut("groups").and_then(Value::as_sequence_mut) else {
        return;
    };

    for group in groups {
        let Some(group) = group.as_mapping_mut() else {
            continue;
        };
        let Some(matchers) = group.get_mut("matchers").and_then(Value::as_sequence_mut) else {
            continue;
        };

        for matcher in matchers {
            normalize_matcher(matcher, &provider_names);
        }
    }
}

fn inject_country_rules(diversion: &mut Mapping) {
    if !bool_value(diversion, "auto-country-rules", false) {
        return;
    }

    let Some(region) = string_value(diversion, "country-or-region") else {
        return;
    };
    let region = region.trim().to_ascii_lowercase();
    if region != "cn" && region != "ir" {
        return;
    }

    let mut matchers = Sequence::new();
    matchers.push(builtin_matcher(format!("geosite:{region}")));
    matchers.push(builtin_matcher(format!("geoip:{region}")));

    let mut group = Mapping::new();
    group.insert(Value::from("name"), Value::from(format!("内置地区直连 ({})", region.to_ascii_uppercase())));
    group.insert(Value::from("enabled"), Value::from(true));
    group.insert(Value::from("logic"), Value::from("or"));
    group.insert(Value::from("action"), Value::from("direct"));
    group.insert(Value::from("matchers"), Value::Sequence(matchers));

    let groups = diversion
        .entry(Value::from("groups"))
        .or_insert_with(|| Value::Sequence(Sequence::new()));
    if let Value::Sequence(groups) = groups {
        groups.insert(0, Value::Mapping(group));
    }
}

fn builtin_matcher(value: String) -> Value {
    let mut matcher = Mapping::new();
    matcher.insert(Value::from("enabled"), Value::from(true));
    matcher.insert(Value::from("type"), Value::from(BUILTIN_TYPE));
    matcher.insert(Value::from("value"), Value::from(value));
    Value::Mapping(matcher)
}

fn normalize_matcher(value: &mut Value, provider_names: &[String]) {
    let Some(matcher) = value.as_mapping_mut() else {
        return;
    };

    let rule_type = string_value(matcher, "type")
        .unwrap_or_default()
        .trim()
        .to_ascii_uppercase()
        .replace(['_', ' '], "-");

    if rule_type == "RULE-SET" {
        matcher
            .entry(Value::from("no-resolve"))
            .or_insert_with(|| Value::from(false));
        normalize_provider_format(matcher);
        return;
    }

    if rule_type != BUILTIN_TYPE {
        return;
    }

    let Some(raw) = string_value(matcher, "value").map(str::trim).filter(|value| !value.is_empty()) else {
        disable(matcher, "empty built-in rule set");
        return;
    };
    let Some((kind, name)) = raw.split_once(':') else {
        disable(matcher, "built-in rule set must use type:name format");
        return;
    };
    let kind = kind.trim().to_ascii_lowercase();
    let name = name.trim();
    if name.is_empty() {
        disable(matcher, "built-in rule set name is empty");
        return;
    }

    match kind.as_str() {
        "geosite" => {
            matcher.insert(Value::from("type"), Value::from("GEOSITE"));
            matcher.insert(Value::from("value"), Value::from(name));
            matcher.insert(Value::from("no-resolve"), Value::from(false));
        }
        "geoip" => {
            matcher.insert(Value::from("type"), Value::from("GEOIP"));
            matcher.insert(Value::from("value"), Value::from(name.to_ascii_uppercase()));
            matcher.insert(Value::from("no-resolve"), Value::from(true));
        }
        "acl" => {
            let provider = string_value(matcher, "provider")
                .map(str::trim)
                .filter(|provider| !provider.is_empty())
                .unwrap_or(name)
                .to_owned();
            let has_url = string_value(matcher, "url").is_some_and(|url| !url.trim().is_empty());
            let provider_exists = provider_names.iter().any(|item| item == &provider);
            if !has_url && !provider_exists {
                disable(matcher, "ACL requires an existing Mihomo rule-provider or a compatible URL");
                return;
            }
            matcher.insert(Value::from("type"), Value::from("RULE-SET"));
            matcher.insert(Value::from("value"), Value::from(provider.as_str()));
            matcher.insert(Value::from("provider"), Value::from(provider));
            matcher.insert(Value::from("no-resolve"), Value::from(false));
            normalize_provider_format(matcher);
        }
        _ => disable(matcher, "unsupported built-in rule set type"),
    }
}

fn normalize_provider_format(matcher: &mut Mapping) {
    let format = string_value(matcher, "format").unwrap_or("yaml");
    let behavior = string_value(matcher, "behavior").unwrap_or("classical");
    if format.eq_ignore_ascii_case("mrs") && behavior.eq_ignore_ascii_case("classical") {
        matcher.insert(Value::from("format"), Value::from("yaml"));
        logging!(warn, Type::Config, "Changed classical MRS diversion rule-provider format to yaml");
    }
}

fn disable(matcher: &mut Mapping, reason: &str) {
    matcher.insert(Value::from("enabled"), Value::from(false));
    logging!(warn, Type::Config, "Disabled invalid Karing-style built-in rule: {}", reason);
}

fn bool_value(map: &Mapping, key: &str, default: bool) -> bool {
    map.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn string_value<'a>(map: &'a Mapping, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapping(yaml: &str) -> Mapping {
        serde_yaml_ng::from_str(yaml).expect("test yaml should be valid")
    }

    #[test]
    fn expands_geosite_and_geoip_builtins() {
        let mut config = mapping(
            "x-karing-diversion:\n  groups:\n    - matchers:\n        - type: RULE-SET-BUILDIN\n          value: geosite:cn\n        - type: RULE-SET-BUILDIN\n          value: geoip:cn\n",
        );
        prepare(&mut config);
        let matchers = config[CONFIG_KEY]["groups"][0]["matchers"].as_sequence().expect("matchers");
        assert_eq!(matchers[0]["type"].as_str(), Some("GEOSITE"));
        assert_eq!(matchers[1]["type"].as_str(), Some("GEOIP"));
        assert_eq!(matchers[1]["value"].as_str(), Some("CN"));
    }

    #[test]
    fn rule_set_defaults_to_resolving_and_classical_mrs_is_repaired() {
        let mut config = mapping(
            "x-karing-diversion:\n  groups:\n    - matchers:\n        - type: RULE-SET\n          value: demo\n          behavior: classical\n          format: mrs\n",
        );
        prepare(&mut config);
        let matcher = &config[CONFIG_KEY]["groups"][0]["matchers"][0];
        assert_eq!(matcher["no-resolve"].as_bool(), Some(false));
        assert_eq!(matcher["format"].as_str(), Some("yaml"));
    }
}
