use clash_verge_logging::{Type, logging};
use serde_yaml_ng::{Mapping, Sequence, Value};

const CONFIG_KEY: &str = "x-karing-diversion";
const CURRENT_GROUP_DEFAULT: &str = "CVR-当前选择";
const AUTO_GROUP_DEFAULT: &str = "CVR-自动选择";
const AUTO_URL_DEFAULT: &str = "https://www.gstatic.com/generate_204";

const PRIVATE_RULES: &[&str] = &[
    "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve",
    "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
    "IP-CIDR,100.64.0.0/10,DIRECT,no-resolve",
    "IP-CIDR,169.254.0.0/16,DIRECT,no-resolve",
    "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve",
    "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
    "IP-CIDR6,fc00::/7,DIRECT,no-resolve",
    "IP-CIDR6,fe80::/10,DIRECT,no-resolve",
];

pub(super) fn apply(config: &mut Mapping) {
    let raw = config
        .remove(CONFIG_KEY)
        .or_else(|| config.remove("x_karing_diversion"));
    let Some(Value::Mapping(diversion)) = raw else {
        return;
    };

    if !bool_value(&diversion, "enabled", false) {
        return;
    }

    let current_group = string_value(&diversion, "current-group-name")
        .unwrap_or(CURRENT_GROUP_DEFAULT)
        .trim()
        .to_owned();
    let auto_group = string_value(&diversion, "auto-group-name")
        .unwrap_or(AUTO_GROUP_DEFAULT)
        .trim()
        .to_owned();

    let mut rule_providers = take_mapping(config, "rule-providers");
    let mut custom_rules = Sequence::new();

    if bool_value(&diversion, "private-network-direct", true) {
        custom_rules.extend(PRIVATE_RULES.iter().map(|rule| Value::from(*rule)));
    }

    if let Some(groups) = diversion.get("groups").and_then(Value::as_sequence) {
        for (index, group) in groups.iter().enumerate() {
            compile_group(
                group,
                index,
                &current_group,
                &auto_group,
                &mut rule_providers,
                &mut custom_rules,
            );
        }
    }

    let fallback_policy = resolve_action(
        diversion.get("fallback"),
        diversion.get("fallback-policy").and_then(Value::as_str),
        &current_group,
        &auto_group,
    )
    .unwrap_or_else(|| current_group.clone());

    let uses_current =
        custom_rules.iter().any(|rule| rule_uses_policy(rule, &current_group)) || fallback_policy == current_group;
    let uses_auto =
        custom_rules.iter().any(|rule| rule_uses_policy(rule, &auto_group)) || fallback_policy == auto_group;

    ensure_managed_proxy_groups(config, &diversion, &current_group, &auto_group, uses_current, uses_auto);

    let original_rules = take_sequence(config, "rules");
    let original_non_terminal = original_rules
        .into_iter()
        .filter(|rule| !is_terminal_rule(rule))
        .collect::<Sequence>();

    if !bool_value(&diversion, "disable-isp-rules", false) {
        let position = string_value(&diversion, "isp-rules-position").unwrap_or("after-custom");
        if position.eq_ignore_ascii_case("before-custom") {
            let mut combined = original_non_terminal;
            combined.extend(custom_rules);
            custom_rules = combined;
        } else {
            custom_rules.extend(original_non_terminal);
        }
    }

    custom_rules.push(Value::from(format!("MATCH,{fallback_policy}")));
    config.insert(Value::from("rules"), Value::Sequence(custom_rules));

    if !rule_providers.is_empty() {
        config.insert(Value::from("rule-providers"), Value::Mapping(rule_providers));
    }

    logging!(
        info,
        Type::Config,
        "Karing-style diversion groups compiled into Mihomo rules"
    );
}

fn compile_group(
    raw_group: &Value,
    group_index: usize,
    current_group: &str,
    auto_group: &str,
    rule_providers: &mut Mapping,
    output: &mut Sequence,
) {
    let Some(group) = raw_group.as_mapping() else {
        return;
    };
    if !bool_value(group, "enabled", true) {
        return;
    }

    let policy_hint = string_value(group, "policy");
    let Some(policy) = resolve_action(group.get("action"), policy_hint, current_group, auto_group) else {
        return;
    };

    let Some(matchers) = group.get("matchers").and_then(Value::as_sequence) else {
        return;
    };

    let group_name = string_value(group, "name").unwrap_or("custom");
    let logic = string_value(group, "logic").unwrap_or("or");
    let mut payloads = Vec::new();

    for (matcher_index, matcher) in matchers.iter().enumerate() {
        if let Some((payload, no_resolve)) =
            compile_matcher(matcher, group_name, group_index, matcher_index, rule_providers)
        {
            payloads.push((payload, no_resolve));
        }
    }

    if payloads.is_empty() {
        return;
    }

    if logic.eq_ignore_ascii_case("and") && payloads.len() > 1 {
        let inner = payloads
            .iter()
            .map(|(payload, _)| format!("({payload})"))
            .collect::<Vec<_>>()
            .join(",");
        output.push(Value::from(format!("AND,({inner}),{policy}")));
        return;
    }

    // Karing's OR semantics are equivalent to adjacent Mihomo rules with the
    // same target. Keeping them separate makes the generated config easier to
    // inspect and preserves no-resolve per matcher.
    for (payload, no_resolve) in payloads {
        let suffix = if no_resolve { ",no-resolve" } else { "" };
        output.push(Value::from(format!("{payload},{policy}{suffix}")));
    }
}

fn compile_matcher(
    raw_matcher: &Value,
    group_name: &str,
    group_index: usize,
    matcher_index: usize,
    rule_providers: &mut Mapping,
) -> Option<(std::string::String, bool)> {
    let matcher = raw_matcher.as_mapping()?;
    if !bool_value(matcher, "enabled", true) {
        return None;
    }

    let raw_type = string_value(matcher, "type")?;
    let rule_type = normalize_rule_type(raw_type);
    let no_resolve = bool_value(matcher, "no-resolve", default_no_resolve(&rule_type));

    if rule_type == "RULE-SET" {
        let provider = string_value(matcher, "provider")
            .or_else(|| string_value(matcher, "value"))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| provider_name(group_name, group_index, matcher_index));

        if let Some(url) = string_value(matcher, "url")
            .map(str::trim)
            .filter(|url| !url.is_empty())
        {
            let behavior = string_value(matcher, "behavior").unwrap_or("classical");
            let format = string_value(matcher, "format").unwrap_or("yaml");
            let interval = matcher.get("interval").and_then(Value::as_u64).unwrap_or(86_400);
            let extension = match format.to_ascii_lowercase().as_str() {
                "mrs" => "mrs",
                "text" => "txt",
                _ => "yaml",
            };

            let mut provider_map = Mapping::new();
            provider_map.insert(Value::from("type"), Value::from("http"));
            provider_map.insert(Value::from("url"), Value::from(url));
            provider_map.insert(
                Value::from("path"),
                Value::from(format!("./ruleset/{provider}.{extension}")),
            );
            provider_map.insert(Value::from("interval"), Value::from(interval));
            provider_map.insert(Value::from("behavior"), Value::from(behavior));
            provider_map.insert(Value::from("format"), Value::from(format));
            rule_providers.insert(Value::from(provider.as_str()), Value::Mapping(provider_map));
        }

        return Some((format!("RULE-SET,{provider}"), no_resolve));
    }

    let value = string_value(matcher, "value")?.trim();
    if value.is_empty() {
        return None;
    }

    Some((format!("{rule_type},{value}"), no_resolve))
}

fn resolve_action(
    action: Option<&Value>,
    policy_hint: Option<&str>,
    current_group: &str,
    auto_group: &str,
) -> Option<std::string::String> {
    let action_name = match action {
        Some(Value::String(value)) => value.as_str(),
        Some(Value::Mapping(map)) => string_value(map, "type").unwrap_or("none"),
        _ => "current",
    }
    .trim();

    match action_name.to_ascii_lowercase().replace('_', "-").as_str() {
        "none" | "off" | "disabled" => None,
        "current" | "current-selected" | "current-selection" => Some(current_group.to_owned()),
        "auto" | "auto-select" | "automatic" => Some(auto_group.to_owned()),
        "direct" => Some("DIRECT".to_owned()),
        "reject" | "block" => Some("REJECT".to_owned()),
        "reject-drop" | "drop" => Some("REJECT-DROP".to_owned()),
        "policy" | "proxy-group" | "node" => policy_hint
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        other if !other.is_empty() => Some(action_name.to_owned()),
        _ => None,
    }
}

fn ensure_managed_proxy_groups(
    config: &mut Mapping,
    diversion: &Mapping,
    current_name: &str,
    auto_name: &str,
    uses_current: bool,
    uses_auto: bool,
) {
    let mut groups = take_sequence(config, "proxy-groups");
    groups.retain(|group| {
        let name = group
            .as_mapping()
            .and_then(|map| map.get("name"))
            .and_then(Value::as_str);
        name != Some(current_name) && name != Some(auto_name)
    });

    if uses_auto {
        let mut auto = Mapping::new();
        auto.insert(Value::from("name"), Value::from(auto_name));
        auto.insert(Value::from("type"), Value::from("url-test"));
        auto.insert(Value::from("include-all"), Value::from(true));
        auto.insert(
            Value::from("url"),
            Value::from(string_value(diversion, "auto-url").unwrap_or(AUTO_URL_DEFAULT)),
        );
        auto.insert(
            Value::from("interval"),
            Value::from(diversion.get("auto-interval").and_then(Value::as_u64).unwrap_or(300)),
        );
        auto.insert(
            Value::from("tolerance"),
            Value::from(diversion.get("auto-tolerance").and_then(Value::as_u64).unwrap_or(50)),
        );
        groups.insert(0, Value::Mapping(auto));
    }

    if uses_current {
        let mut current = Mapping::new();
        current.insert(Value::from("name"), Value::from(current_name));
        current.insert(Value::from("type"), Value::from("select"));
        current.insert(Value::from("include-all"), Value::from(true));
        let mut proxies = Sequence::new();
        if uses_auto {
            proxies.push(Value::from(auto_name));
        }
        proxies.push(Value::from("DIRECT"));
        current.insert(Value::from("proxies"), Value::Sequence(proxies));
        groups.insert(0, Value::Mapping(current));
    }

    if !groups.is_empty() {
        config.insert(Value::from("proxy-groups"), Value::Sequence(groups));
    }
}

fn normalize_rule_type(value: &str) -> std::string::String {
    let normalized = value.trim().to_ascii_uppercase().replace(['_', ' '], "-");
    match normalized.as_str() {
        "APP-PACKAGE" | "PACKAGE-NAME" | "PACKAGE" => "PROCESS-NAME".to_owned(),
        "IP-CIDR-6" => "IP-CIDR6".to_owned(),
        _ => normalized,
    }
}

fn default_no_resolve(rule_type: &str) -> bool {
    matches!(rule_type, "GEOIP" | "IP-CIDR" | "IP-CIDR6" | "IP-SUFFIX" | "IP-ASN")
}

fn provider_name(group_name: &str, group_index: usize, matcher_index: usize) -> std::string::String {
    let slug = group_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<std::string::String>();
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        format!("cvr-rule-{group_index}-{matcher_index}")
    } else {
        format!("cvr-{slug}-{group_index}-{matcher_index}")
    }
}

fn rule_uses_policy(rule: &Value, policy: &str) -> bool {
    rule.as_str()
        .is_some_and(|raw| raw.split(',').any(|part| part.trim().eq_ignore_ascii_case(policy)))
}

fn is_terminal_rule(rule: &Value) -> bool {
    rule.as_str().is_some_and(|raw| {
        let upper = raw.trim_start().to_ascii_uppercase();
        upper.starts_with("MATCH,") || upper.starts_with("FINAL,")
    })
}

fn bool_value(map: &Mapping, key: &str, default: bool) -> bool {
    map.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn string_value<'a>(map: &'a Mapping, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

fn take_sequence(config: &mut Mapping, key: &str) -> Sequence {
    match config.remove(key) {
        Some(Value::Sequence(sequence)) => sequence,
        _ => Sequence::new(),
    }
}

fn take_mapping(config: &mut Mapping, key: &str) -> Mapping {
    match config.remove(key) {
        Some(Value::Mapping(mapping)) => mapping,
        _ => Mapping::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapping(yaml: &str) -> Mapping {
        serde_yaml_ng::from_str(yaml).expect("test yaml should be valid")
    }

    #[test]
    fn compiles_custom_rules_and_strips_private_config() {
        let mut config = mapping(
            r#"
proxies:
  - name: node-a
    type: ss
proxy-groups:
  - name: airport
    type: select
    proxies: [node-a]
rules:
  - DOMAIN-SUFFIX,airport.example,airport
  - MATCH,airport
x-karing-diversion:
  enabled: true
  private-network-direct: false
  disable-isp-rules: false
  fallback: current
  groups:
    - name: AI
      action: current
      logic: or
      matchers:
        - type: DOMAIN-SUFFIX
          value: openai.com
"#,
        );

        apply(&mut config);
        assert!(!config.contains_key(CONFIG_KEY));

        let rules = config.get("rules").and_then(Value::as_sequence).expect("rules");
        assert_eq!(rules[0].as_str(), Some("DOMAIN-SUFFIX,openai.com,CVR-当前选择"));
        assert_eq!(rules[1].as_str(), Some("DOMAIN-SUFFIX,airport.example,airport"));
        assert_eq!(rules.last().and_then(Value::as_str), Some("MATCH,CVR-当前选择"));
    }

    #[test]
    fn disables_subscription_rules() {
        let mut config = mapping(
            r#"
rules:
  - DOMAIN-SUFFIX,airport.example,DIRECT
  - MATCH,DIRECT
x-karing-diversion:
  enabled: true
  private-network-direct: false
  disable-isp-rules: true
  fallback: direct
  groups: []
"#,
        );

        apply(&mut config);
        let rules = config.get("rules").and_then(Value::as_sequence).expect("rules");
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].as_str(), Some("MATCH,DIRECT"));
    }
}
