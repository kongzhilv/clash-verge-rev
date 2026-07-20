use clash_verge_logging::{Type, logging};
use serde_yaml_ng::{Mapping, Sequence, Value};

const CONFIG_KEY: &str = "x-karing-diversion";

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
