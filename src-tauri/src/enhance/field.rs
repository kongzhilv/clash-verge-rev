use serde_yaml_ng::{Mapping, Sequence, Value};
use smartstring::alias::String;

pub const HANDLE_FIELDS: [&str; 12] = [
    "mode",
    "redir-port",
    "tproxy-port",
    "mixed-port",
    "socks-port",
    "port",
    "allow-lan",
    "log-level",
    "ipv6",
    "external-controller",
    "secret",
    "unified-delay",
];

pub const DEFAULT_FIELDS: [&str