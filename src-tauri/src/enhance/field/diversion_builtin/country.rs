use serde_yaml_ng::{Mapping, Sequence, Value};

pub(super) fn inject(diversion: &mut Mapping) {
    if !diversion
        .get("auto-country-rules")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return;
    }

    let Some(region) = diversion
        .get("country-or-region")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };

    let region = region.to_ascii_lowercase();
    if region != "cn" && region != "ir" {
        return;
    }

    if !diversion.contains_key("groups") {
        diversion.insert(Value::from("groups"), Value::Sequence(Sequence::new()));
    }

    let Some(groups) = diversion.get_mut("groups").and_then(Value::as_sequence_mut) else {
        return;
    };

    let generated_name = format!("内置地区直连 ({})", region.to_ascii_uppercase());
    let already_exists = groups.iter().any(|group| {
        group
            .as_mapping()
            .and_then(|map| map.get("name"))
            .and_then(Value::as_str)
            == Some(generated_name.as_str())
    });
    if already_exists {
        return;
    }

    let mut matchers = Sequence::new();
    matchers.push(builtin(format!("geosite:{region}")));
    matchers.push(builtin(format!("geoip:{region}")));

    let mut group = Mapping::new();
    group.insert(Value::from("name"), Value::from(generated_name));
    group.insert(Value::from("enabled"), Value::from(true));
    group.insert(Value::from("logic"), Value::from("or"));
    group.insert(Value::from("action"), Value::from("direct"));
    group.insert(Value::from("matchers"), Value::Sequence(matchers));
    groups.insert(0, Value::Mapping(group));
}

fn builtin(value: String) -> Value {
    let mut matcher = Mapping::new();
    matcher.insert(Value::from("enabled"), Value::from(true));
    matcher.insert(Value::from("type"), Value::from("RULE-SET-BUILDIN"));
    matcher.insert(Value::from("value"), Value::from(value));
    Value::Mapping(matcher)
}
