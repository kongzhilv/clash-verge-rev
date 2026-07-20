use serde_yaml_ng::{Mapping, Value};

const BUILTIN_TYPE: &str = "RULE-SET-BUILDIN";

pub(super) fn normalize(value: &mut Value, provider_names: &[String]) {
    let Some(matcher) = value.as_mapping_mut() else {
        return;
    };

    let rule_type = matcher
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_uppercase()
        .replace(['_', ' '], "-");

    if rule_type != BUILTIN_TYPE {
        return;
    }

    let Some(raw) = matcher.get("value").and_then(Value::as_str) else {
        disable(matcher);
        return;
    };

    let Some((kind, name)) = raw.split_once(':') else {
        disable(matcher);
        return;
    };

    match kind.trim().to_ascii_lowercase().as_str() {
        "geosite" => {
            matcher.insert(Value::from("type"), Value::from("GEOSITE"));
            matcher.insert(Value::from("value"), Value::from(name));
        }
        "geoip" => {
            matcher.insert(Value::from("type"), Value::from("GEOIP"));
            matcher.insert(Value::from("value"), Value::from(name.to_ascii_uppercase()));
            matcher.insert(Value::from("no-resolve"), Value::from(true));
        }
        "acl" => {
            if provider_names.iter().any(|p| p == name) {
                matcher.insert(Value::from("type"), Value::from("RULE-SET"));
                matcher.insert(Value::from("value"), Value::from(name));
            } else {
                disable(matcher);
            }
        }
        _ => disable(matcher),
    }
}

fn disable(matcher: &mut Mapping) {
    matcher.insert(Value::from("enabled"), Value::from(false));
}
