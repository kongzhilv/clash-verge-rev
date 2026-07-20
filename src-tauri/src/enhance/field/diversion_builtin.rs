use clash_verge_logging::{Type, logging};
use serde_yaml_ng::{Mapping, Sequence, Value};

const CONFIG_KEY: &str = "x-karing-diversion";
const CONFIG_KEY_ALT: &str = "x_karing_diversion";
const BUILTIN_TYPE: &str = "RULE-SET-BUILDIN";

pub(super) fn prepare(config: &mut Mapping) {
    let provider_names = config
        .get("rule-providers")
