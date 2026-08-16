use std::{
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

use flexi_logger::{
    Cleanup, Criterion, DeferredNow, FileSpec,
    writers::{FileLogWriter, LogWriter as _},
};
use log::{Level, Record};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::utils::dirs;

const DIAGNOSTIC_MAX_SIZE_BYTES: u64 = 2 * 1024 * 1024;
const DIAGNOSTIC_MAX_FILES: usize = 16;

static SESSION_ID: OnceLock<String> = OnceLock::new();
static DIAGNOSTIC_WRITER: OnceLock<Mutex<Option<FileLogWriter>>> = OnceLock::new();

fn session_id() -> &'static str {
    SESSION_ID.get_or_init(|| {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("{}-{}", std::process::id(), now)
    })
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "password",
        "passwd",
        "secret",
        "token",
        "authorization",
        "cookie",
        "uuid",
        "private-key",
        "private_key",
        "subscription",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

fn sanitize_value(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sanitized = Map::with_capacity(map.len());
            for (key, value) in map {
                if is_sensitive_key(&key) {
                    sanitized.insert(key, Value::String("<redacted>".into()));
                } else {
                    sanitized.insert(key, sanitize_value(value));
                }
            }
            Value::Object(sanitized)
        }
        Value::Array(values) => Value::Array(values.into_iter().map(sanitize_value).collect()),
        other => other,
    }
}

fn build_writer() -> anyhow::Result<FileLogWriter> {
    let log_dir = dirs::app_logs_dir()?;
    Ok(FileLogWriter::builder(
        FileSpec::default()
            .directory(log_dir)
            .basename("diagnostic")
            .suppress_timestamp(),
    )
    .format(clash_verge_logger::file_format_without_level)
    .rotate(
        Criterion::Size(DIAGNOSTIC_MAX_SIZE_BYTES),
        flexi_logger::Naming::TimestampsCustomFormat {
            current_infix: Some("latest"),
            format: "%Y-%m-%d_%H-%M-%S",
        },
        Cleanup::KeepLogFiles(DIAGNOSTIC_MAX_FILES),
    )
    .try_build()?)
}

fn writer() -> &'static Mutex<Option<FileLogWriter>> {
    DIAGNOSTIC_WRITER.get_or_init(|| Mutex::new(build_writer().ok()))
}

pub fn event(level: Level, category: &str, name: &str, fields: Value) {
    let payload = sanitize_value(json!({
        "ts_ms": epoch_ms(),
        "session": session_id(),
        "category": category,
        "event": name,
        "fields": fields,
    }));

    let message = match serde_json::to_string(&payload) {
        Ok(value) => value,
        Err(_) => return,
    };

    let mut guard = writer().lock();
    if guard.is_none() {
        *guard = build_writer().ok();
    }
    let Some(file_writer) = guard.as_ref() else {
        return;
    };

    let mut now = DeferredNow::default();
    let args = format_args!("{}", message);
    let record = Record::builder()
        .args(args)
        .level(level)
        .target("diagnostic")
        .build();
    let _ = file_writer.write(&mut now, &record);
}

pub fn info(category: &str, name: &str, fields: Value) {
    event(Level::Info, category, name, fields);
}

pub fn warn(category: &str, name: &str, fields: Value) {
    event(Level::Warn, category, name, fields);
}

pub fn error(category: &str, name: &str, fields: Value) {
    event(Level::Error, category, name, fields);
}

pub fn flush() {
    if let Some(writer) = writer().lock().as_ref() {
        let _ = writer.flush();
    }
}
