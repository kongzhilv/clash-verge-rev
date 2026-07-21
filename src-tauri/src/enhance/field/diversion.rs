use clash_verge_logging::{Type, logging};
use serde_yaml_ng::{Mapping, Sequence, Value};

const CONFIG_KEY: &str = "x-karing-diversion";
const CURRENT_GROUP_DEFAULT: &str = "CVR-当前选择";
const AUTO_GROUP_DEFAULT: &str = "CVR-自动选择";
const AUTO_URL_DEFAULT: &str = "https://www.gstatic.com/generate_204";

const PRIVATE_RULES: &[&str] = &[
    "IP-CIDR