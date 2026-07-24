use clash_verge_logging::{Type, logging};
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

    if rule_type == "RULE-SET" {
        matcher
            .entry(Value::from("no-resolve"))
            .or_insert_with(|| Value::from(false));
        repair_provider_format(matcher);
        return;
    }

    if rule_type != BUILTIN_TYPE {
        return;
    }

    let raw = matcher
        .get("value")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    let Some((kind, name)) = raw.split_once(':') else {
        disable(matcher, "built-in rule set must use type:name format");
        return;
    };

    let kind = kind.trim().to_ascii_lowercase();
    let name = name.trim().to_owned();
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
        "acl" => normalize_acl(matcher, &name, provider_names),
        _ => disable(matcher, "unsupported built-in rule set type"),
    }
}

fn normalize_acl(matcher: &mut Mapping, name: &str, provider_names: &[String]) {
    let provider = matcher
        .get("provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(name)
        .to_owned();
    let has_url = matcher
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(|url| !url.trim().is_empty());
    let provider_exists = provider_names.iter().any(|item| item == &provider);

    if !has_url && !provider_exists {
        disable(matcher, "ACL requires an existing rule-provider or URL");
        return;
    }

    matcher.insert(Value::from("type"), Value::from("RULE-SET"));
    matcher.insert(Value::from("value"), Value::from(provider.as_str()));
    matcher.insert(Value::from("provider"), Value::from(provider));
    matcher.insert(Value::from("no-resolve"), Value::from(false));
    repair_provider_format(matcher);
}

fn repair_provider_format(matcher: &mut Mapping) {
    let format = matcher
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("yaml")
        .to_owned();
    let behavior = matcher
        .get("behavior")
        .and_then(Value::as_str)
        .unwrap_or("classical")
        .to_owned();

    if format.eq_ignore_ascii_case("mrs") && behavior.eq_ignore_ascii_case("classical") {
        matcher.insert(Value::from("format"), Value::from("yaml"));
        logging!(
            warn,
            Type::Config,
            "Changed classical MRS diversion provider format to yaml"
        );
    }
}

fn disable(matcher: &mut Mapping, reason: &str) {
    matcher.insert(Value::from("enabled"), Value::from(false));
    logging!(
        warn,
        Type::Config,
        "Disabled invalid Karing-style built-in rule: {}",
        reason
    );
}
