use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use crate::{
    core::{CoreManager, diagnostics, handle, manager::RunningMode},
    process::AsyncHandler,
    utils::dirs,
};

const MONITOR_INTERVAL: Duration = Duration::from_millis(500);
const FAILURE_WINDOW: Duration = Duration::from_secs(5);
const FAILURE_IDLE_FLUSH: Duration = Duration::from_millis(1500);
const CHURN_WINDOW: Duration = Duration::from_secs(3);
const CHURN_MIN_CONNECTIONS: u32 = 24;
const CHURN_MIN_TARGET_CONNECTIONS: u32 = 12;
const MAX_DIMENSION_VALUES: usize = 32;
const MAX_TOP_VALUES: usize = 8;
const MAX_SELECTION_DEPTH: usize = 6;
const SAMPLE_ERROR_MAX_CHARS: usize = 220;

static MONITOR_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct FailureKey {
    source: &'static str,
    network: &'static str,
    outbound: String,
    error_family: &'static str,
    stage: &'static str,
}

#[derive(Debug)]
struct FailureEvent {
    network: &'static str,
    outbound: String,
    rule: Option<String>,
    process: Option<String>,
    target: String,
    error_family: &'static str,
    stage: &'static str,
    sample_error: String,
}

#[derive(Debug)]
struct RouteEvent {
    network: &'static str,
    outbound: String,
    selected_hint: Option<String>,
    process: Option<String>,
    target: String,
}

#[derive(Debug)]
struct FailureBucket {
    count: u32,
    first_seen: Instant,
    last_seen: Instant,
    first_seen_ms: u128,
    last_seen_ms: u128,
    targets: HashMap<String, u32>,
    processes: HashMap<String, u32>,
    rules: HashMap<String, u32>,
    sample_error: String,
}

#[derive(Debug)]
struct ChurnBucket {
    count: u32,
    first_seen: Instant,
    last_seen_ms: u128,
    targets: HashMap<String, u32>,
    processes: HashMap<String, u32>,
    observed_selections: HashMap<String, u32>,
}

#[derive(Debug)]
struct FailureSummary {
    key: FailureKey,
    bucket: FailureBucket,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct ChurnKey {
    source: &'static str,
    network: &'static str,
    outbound: String,
}

#[derive(Debug)]
struct ChurnSummary {
    key: ChurnKey,
    bucket: ChurnBucket,
}

#[derive(Debug, Default)]
struct TrafficAggregator {
    failures: HashMap<FailureKey, FailureBucket>,
    churn: HashMap<ChurnKey, ChurnBucket>,
}

#[derive(Debug, Default)]
struct LogCursor {
    source: Option<&'static str>,
    consumed_bytes: usize,
    prefix: String,
}

#[derive(Debug, Default)]
struct SelectionSnapshot {
    chain: Vec<String>,
    error: Option<String>,
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn bounded_increment(map: &mut HashMap<String, u32>, value: Option<String>) {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return;
    };

    if let Some(count) = map.get_mut(&value) {
        *count = count.saturating_add(1);
    } else if map.len() < MAX_DIMENSION_VALUES {
        map.insert(value, 1);
    }
}

fn top_values(map: &HashMap<String, u32>) -> Vec<Value> {
    let mut values: Vec<_> = map.iter().collect();
    values.sort_by_key(|(_, count)| Reverse(**count));
    values
        .into_iter()
        .take(MAX_TOP_VALUES)
        .map(|(value, count)| json!({"value": value, "count": count}))
        .collect()
}

fn redact_url_query(token: &str) -> String {
    let Some(scheme_index) = token.find("://") else {
        return token.to_string();
    };
    let query_search_start = scheme_index + 3;
    let Some(query_offset) = token.get(query_search_start..).and_then(|rest| rest.find('?')) else {
        return token.to_string();
    };
    let query_index = query_search_start + query_offset;
    format!("{}?<query-redacted>", &token[..query_index])
}

fn compact_error(error: &str) -> String {
    let normalized = error.replace(['\r', '\n', '\t'], " ");
    let mut compact = String::new();
    for token in normalized.split_whitespace() {
        if !compact.is_empty() {
            compact.push(' ');
        }
        compact.push_str(redact_url_query(token).as_str());
        if compact.chars().count() >= SAMPLE_ERROR_MAX_CHARS {
            break;
        }
    }
    compact.chars().take(SAMPLE_ERROR_MAX_CHARS).collect()
}

fn parse_host_port(value: &str) -> (String, Option<u16>) {
    let value = value.trim().trim_end_matches('"');
    if let Some(rest) = value.strip_prefix('[')
        && let Some((host, port)) = rest.split_once("]:")
        && let Ok(port) = port.parse::<u16>()
    {
        return (host.to_string(), Some(port));
    }

    if let Some((host, port)) = value.rsplit_once(':')
        && let Ok(port) = port.parse::<u16>()
    {
        return (host.to_string(), Some(port));
    }

    (value.to_string(), None)
}

fn source_endpoint(value: &str) -> &str {
    value.split_once('(').map_or(value, |(endpoint, _)| endpoint)
}

fn looks_like_source(value: &str) -> bool {
    let (_, port) = parse_host_port(source_endpoint(value));
    port.is_some()
}

fn split_outbound_and_source(value: &str) -> Option<(&str, &str)> {
    for (index, _) in value.match_indices(' ').rev() {
        let source = value.get(index + 1..)?.trim();
        if looks_like_source(source) {
            return Some((value.get(..index)?.trim(), source));
        }
    }
    None
}

fn process_from_source(source: &str) -> Option<String> {
    let start = source.find('(')?;
    let end = source.rfind(')')?;
    (end > start + 1).then(|| source[start + 1..end].to_string())
}

fn parse_failure_left(value: &str) -> Option<(String, Option<String>, String)> {
    const MATCH_MARKER: &str = " (match ";
    if let Some(match_index) = value.find(MATCH_MARKER) {
        let outbound = value.get(..match_index)?.trim().to_string();
        let after_match = value.get(match_index + MATCH_MARKER.len()..)?;
        let rule_end = after_match.find(") ")?;
        let rule = after_match.get(..rule_end)?.trim().to_string();
        let source = after_match.get(rule_end + 2..)?.trim().to_string();
        return Some((outbound, Some(rule), source));
    }

    let (outbound, source) = split_outbound_and_source(value)?;
    Some((outbound.to_string(), None, source.to_string()))
}

fn classify_error(error: &str, outbound: &str) -> (&'static str, &'static str) {
    let normalized = error.to_ascii_lowercase();
    let family = if normalized.contains("dns resolve failed") || normalized.contains("all dns requests failed") {
        "dns"
    } else if normalized.contains("only one usage of each socket address")
        || normalized.contains("address already in use")
    {
        "socket_exhaustion"
    } else if normalized.contains("network is unreachable") || normalized.contains("unreachable host") {
        "network_unreachable"
    } else if normalized.contains("authentication failed") || normalized.contains("unauthorized") {
        "authentication"
    } else if normalized.contains("certificate") || normalized.contains("tls handshake") {
        "tls"
    } else if normalized.contains("quic") {
        "quic"
    } else if normalized.contains("connection refused") {
        "connection_refused"
    } else if normalized.contains("connection reset")
        || normalized.contains("forcibly closed")
        || normalized.contains("connection closed")
        || normalized.contains("closed network connection")
    {
        "connection_closed"
    } else if normalized.contains("context deadline exceeded")
        || normalized.contains("i/o timeout")
        || normalized.contains("timed out")
        || normalized.contains("timeout")
    {
        "timeout"
    } else if normalized.contains("context canceled") || normalized.contains("context cancelled") {
        "canceled"
    } else {
        "other"
    };

    let stage = if family == "dns" {
        "dns"
    } else if normalized.contains(" connect error:") && !outbound.eq_ignore_ascii_case("DIRECT") {
        "proxy_upstream"
    } else if outbound.eq_ignore_ascii_case("DIRECT") {
        "direct_destination"
    } else {
        "outbound_transport"
    };

    (family, stage)
}

fn network_marker<'a>(line: &'a str, dial: bool) -> Option<(&'static str, &'a str)> {
    let tcp = if dial { "[TCP] dial " } else { "[TCP] " };
    let udp = if dial { "[UDP] dial " } else { "[UDP] " };
    if let Some(index) = line.find(tcp) {
        return line.get(index + tcp.len()..).map(|rest| ("TCP", rest));
    }
    line.find(udp)
        .and_then(|index| line.get(index + udp.len()..))
        .map(|rest| ("UDP", rest))
}

fn parse_failure(line: &str) -> Option<FailureEvent> {
    let (network, rest) = network_marker(line, true)?;
    let rest = rest.trim_end_matches('"');
    let (left, right) = rest.split_once(" --> ")?;
    let (target, error) = right.split_once(" error: ")?;
    let (outbound, rule, source) = parse_failure_left(left)?;
    let (error_family, stage) = classify_error(error, outbound.as_str());
    let (target_host, target_port) = parse_host_port(target);
    let target = target_port.map_or(target_host.clone(), |port| format!("{target_host}:{port}"));

    Some(FailureEvent {
        network,
        outbound,
        rule,
        process: process_from_source(source.as_str()),
        target,
        error_family,
        stage,
        sample_error: compact_error(error),
    })
}

fn parse_selection(value: &str) -> (String, Option<String>) {
    let value = value.trim().trim_end_matches('"');
    if value.ends_with(']')
        && let Some(open) = value.rfind('[')
        && open > 0
    {
        let outbound = value[..open].trim();
        let selected = value[open + 1..value.len() - 1].trim();
        if !outbound.is_empty() && !selected.is_empty() {
            return (outbound.to_string(), Some(selected.to_string()));
        }
    }
    (value.to_string(), None)
}

fn parse_route(line: &str) -> Option<RouteEvent> {
    let (network, rest) = network_marker(line, false)?;
    if rest.starts_with("dial ") {
        return None;
    }

    let (source, right) = rest.trim_end_matches('"').split_once(" --> ")?;
    let using_index = right.rfind(" using ")?;
    let before_using = right.get(..using_index)?;
    let selection = right.get(using_index + " using ".len()..)?;
    let target = before_using
        .split_once(" match ")
        .map_or(before_using, |(target, _)| target);
    let (target_host, target_port) = parse_host_port(target);
    let target = target_port.map_or(target_host.clone(), |port| format!("{target_host}:{port}"));
    let (outbound, selected_hint) = parse_selection(selection);

    Some(RouteEvent {
        network,
        outbound,
        selected_hint,
        process: process_from_source(source),
        target,
    })
}

fn parse_health_check_group(line: &str) -> Option<String> {
    const PREFIX: &str = "because ";
    const SUFFIX: &str = " failed multiple times, active health check";
    let start = line.find(PREFIX)? + PREFIX.len();
    let rest = line.get(start..)?;
    let end = rest.find(SUFFIX)?;
    let group = rest.get(..end)?.trim();
    (!group.is_empty()).then(|| group.to_string())
}

impl FailureBucket {
    fn new(event: &FailureEvent, now: Instant, now_ms: u128) -> Self {
        let mut targets = HashMap::new();
        let mut processes = HashMap::new();
        let mut rules = HashMap::new();
        bounded_increment(&mut targets, Some(event.target.clone()));
        bounded_increment(&mut processes, event.process.clone());
        bounded_increment(&mut rules, event.rule.clone());
        Self {
            count: 1,
            first_seen: now,
            last_seen: now,
            first_seen_ms: now_ms,
            last_seen_ms: now_ms,
            targets,
            processes,
            rules,
            sample_error: event.sample_error.clone(),
        }
    }

    fn observe(&mut self, event: &FailureEvent, now: Instant, now_ms: u128) {
        self.count = self.count.saturating_add(1);
        self.last_seen = now;
        self.last_seen_ms = now_ms;
        bounded_increment(&mut self.targets, Some(event.target.clone()));
        bounded_increment(&mut self.processes, event.process.clone());
        bounded_increment(&mut self.rules, event.rule.clone());
    }

    fn ready(&self, now: Instant, force: bool) -> bool {
        force
            || now.duration_since(self.first_seen) >= FAILURE_WINDOW
            || now.duration_since(self.last_seen) >= FAILURE_IDLE_FLUSH
    }
}

impl ChurnBucket {
    fn new(event: &RouteEvent, now: Instant, now_ms: u128) -> Self {
        let mut targets = HashMap::new();
        let mut processes = HashMap::new();
        let mut observed_selections = HashMap::new();
        bounded_increment(&mut targets, Some(event.target.clone()));
        bounded_increment(&mut processes, event.process.clone());
        bounded_increment(&mut observed_selections, event.selected_hint.clone());
        Self {
            count: 1,
            first_seen: now,
            last_seen_ms: now_ms,
            targets,
            processes,
            observed_selections,
        }
    }

    fn observe(&mut self, event: &RouteEvent, now_ms: u128) {
        self.count = self.count.saturating_add(1);
        self.last_seen_ms = now_ms;
        bounded_increment(&mut self.targets, Some(event.target.clone()));
        bounded_increment(&mut self.processes, event.process.clone());
        bounded_increment(&mut self.observed_selections, event.selected_hint.clone());
    }

    fn max_target_count(&self) -> u32 {
        self.targets.values().copied().max().unwrap_or(0)
    }

    fn suspicious(&self) -> bool {
        self.count >= CHURN_MIN_CONNECTIONS && self.max_target_count() >= CHURN_MIN_TARGET_CONNECTIONS
    }
}

impl TrafficAggregator {
    fn observe_failure(&mut self, source: &'static str, event: FailureEvent, now: Instant, now_ms: u128) {
        let key = FailureKey {
            source,
            network: event.network,
            outbound: event.outbound.clone(),
            error_family: event.error_family,
            stage: event.stage,
        };
        self.failures
            .entry(key)
            .and_modify(|bucket| bucket.observe(&event, now, now_ms))
            .or_insert_with(|| FailureBucket::new(&event, now, now_ms));
    }

    fn observe_route(&mut self, source: &'static str, event: RouteEvent, now: Instant, now_ms: u128) {
        let key = ChurnKey {
            source,
            network: event.network,
            outbound: event.outbound.clone(),
        };
        self.churn
            .entry(key)
            .and_modify(|bucket| bucket.observe(&event, now_ms))
            .or_insert_with(|| ChurnBucket::new(&event, now, now_ms));
    }

    fn take_failure_summaries(&mut self, now: Instant, force: bool) -> Vec<FailureSummary> {
        let old = std::mem::take(&mut self.failures);
        let mut ready = Vec::new();
        for (key, bucket) in old {
            if bucket.ready(now, force) {
                ready.push(FailureSummary { key, bucket });
            } else {
                self.failures.insert(key, bucket);
            }
        }
        ready
    }

    fn take_churn_summaries(&mut self, now: Instant, force: bool) -> Vec<ChurnSummary> {
        let old = std::mem::take(&mut self.churn);
        let mut ready = Vec::new();
        for (key, bucket) in old {
            if force || now.duration_since(bucket.first_seen) >= CHURN_WINDOW {
                if bucket.suspicious() {
                    ready.push(ChurnSummary { key, bucket });
                }
            } else {
                self.churn.insert(key, bucket);
            }
        }
        ready
    }
}

impl LogCursor {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn delta<'a>(&mut self, source: &'static str, content: &'a str) -> Option<&'a str> {
        let prefix: String = content.chars().take(64).collect();
        if self.source != Some(source) {
            self.source = Some(source);
            self.consumed_bytes = content.len();
            self.prefix = prefix;
            return None;
        }

        let replaced = self.consumed_bytes > content.len() || self.prefix != prefix;
        let start = if replaced { 0 } else { self.consumed_bytes };
        self.consumed_bytes = content.len();
        self.prefix = prefix;
        content.get(start..).or(Some(content))
    }
}

fn active_log(mode: &RunningMode) -> Option<(&'static str, PathBuf)> {
    match mode {
        RunningMode::Service => dirs::service_log_dir()
            .ok()
            .map(|path| ("service", path.join("service_latest.log"))),
        RunningMode::Sidecar => dirs::sidecar_log_dir()
            .ok()
            .map(|path| ("sidecar", path.join("sidecar_latest.log"))),
        RunningMode::NotRunning => None,
    }
}

async fn resolve_selection(outbound: &str) -> SelectionSnapshot {
    let mut snapshot = SelectionSnapshot {
        chain: vec![outbound.to_string()],
        error: None,
    };
    let mut current = outbound.to_string();
    let mut seen = HashSet::from([current.clone()]);

    for _ in 0..MAX_SELECTION_DEPTH {
        let result = {
            let mihomo = handle::Handle::mihomo().await;
            mihomo.get_proxy_by_name(current.as_str()).await
        };
        let proxy = match result {
            Ok(proxy) => proxy,
            Err(error) => {
                snapshot.error = Some(compact_error(error.to_string().as_str()));
                break;
            }
        };
        let Some(next) = proxy.now.map(|value| value.to_string()) else {
            break;
        };
        if next.is_empty() || !seen.insert(next.clone()) {
            break;
        }
        snapshot.chain.push(next.clone());
        current = next;
    }

    snapshot
}

async fn emit_failure(summary: FailureSummary) {
    let selection = resolve_selection(summary.key.outbound.as_str()).await;
    diagnostics::warn(
        "outbound",
        "outbound-failure-summary",
        json!({
            "source": summary.key.source,
            "network": summary.key.network,
            "outbound": summary.key.outbound,
            "selection_chain": selection.chain,
            "selection_lookup_error": selection.error,
            "stage": summary.key.stage,
            "error_family": summary.key.error_family,
            "count": summary.bucket.count,
            "first_seen_ms": summary.bucket.first_seen_ms,
            "last_seen_ms": summary.bucket.last_seen_ms,
            "window_ms": summary.bucket.last_seen_ms.saturating_sub(summary.bucket.first_seen_ms),
            "top_targets": top_values(&summary.bucket.targets),
            "top_processes": top_values(&summary.bucket.processes),
            "top_rules": top_values(&summary.bucket.rules),
            "sample_error": summary.bucket.sample_error,
        }),
    );
}

async fn emit_churn(summary: ChurnSummary) {
    let selection = resolve_selection(summary.key.outbound.as_str()).await;
    diagnostics::warn(
        "outbound",
        "outbound-connection-churn",
        json!({
            "source": summary.key.source,
            "network": summary.key.network,
            "outbound": summary.key.outbound,
            "selection_chain": selection.chain,
            "selection_lookup_error": selection.error,
            "observed_selections": top_values(&summary.bucket.observed_selections),
            "connection_count": summary.bucket.count,
            "last_seen_ms": summary.bucket.last_seen_ms,
            "top_targets": top_values(&summary.bucket.targets),
            "top_processes": top_values(&summary.bucket.processes),
            "heuristic": true,
            "reason": "high repeated connection opens to the same target in a short window; this is a diagnostic signal, not proof of a transport failure",
        }),
    );
}

async fn emit_health_check(source: &'static str, group: String) {
    let selection = resolve_selection(group.as_str()).await;
    diagnostics::warn(
        "outbound",
        "proxy-group-health-check-triggered",
        json!({
            "source": source,
            "group": group,
            "selection_chain": selection.chain,
            "selection_lookup_error": selection.error,
        }),
    );
}

async fn flush_ready(aggregator: &mut TrafficAggregator, force: bool) {
    let now = Instant::now();
    for summary in aggregator.take_failure_summaries(now, force) {
        emit_failure(summary).await;
    }
    for summary in aggregator.take_churn_summaries(now, force) {
        emit_churn(summary).await;
    }
}

async fn consume_delta(source: &'static str, delta: &str, aggregator: &mut TrafficAggregator) {
    let now = Instant::now();
    let now_ms = epoch_ms();
    let mut health_groups = Vec::new();

    for line in delta.lines() {
        if let Some(failure) = parse_failure(line) {
            aggregator.observe_failure(source, failure, now, now_ms);
        } else if let Some(route) = parse_route(line) {
            aggregator.observe_route(source, route, now, now_ms);
        }
        if let Some(group) = parse_health_check_group(line) {
            health_groups.push(group);
        }
    }

    for group in health_groups {
        emit_health_check(source, group).await;
    }
}

async fn monitor_loop() {
    let mut cursor = LogCursor::default();
    let mut aggregator = TrafficAggregator::default();
    let mut active_source = None;
    let mut interval = tokio::time::interval(MONITOR_INTERVAL);

    loop {
        interval.tick().await;
        let mode = CoreManager::global().get_running_mode();
        let Some((source, path)) = active_log(mode.as_ref()) else {
            if active_source.take().is_some() {
                flush_ready(&mut aggregator, true).await;
                cursor.reset();
            }
            continue;
        };

        let content = match fs::read_to_string(path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        if active_source != Some(source) {
            active_source = Some(source);
            diagnostics::info(
                "outbound",
                "outbound-monitor-source",
                json!({"source": source, "baseline_bytes": content.len()}),
            );
        }
        if let Some(delta) = cursor.delta(source, content.as_str())
            && !delta.is_empty()
        {
            consume_delta(source, delta, &mut aggregator).await;
        }
        flush_ready(&mut aggregator, false).await;
    }
}

pub fn ensure_monitor_running() {
    if MONITOR_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    AsyncHandler::spawn(|| async {
        diagnostics::info(
            "outbound",
            "outbound-monitor-started",
            json!({
                "interval_ms": MONITOR_INTERVAL.as_millis(),
                "failure_window_ms": FAILURE_WINDOW.as_millis(),
                "churn_window_ms": CHURN_WINDOW.as_millis(),
                "churn_min_connections": CHURN_MIN_CONNECTIONS,
                "churn_min_target_connections": CHURN_MIN_TARGET_CONNECTIONS,
            }),
        );
        monitor_loop().await;
    });
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::{ChurnBucket, RouteEvent, classify_error, parse_failure, parse_health_check_group, parse_route};
    use std::time::Instant;

    #[test]
    fn error_samples_redact_url_queries() {
        let compact = super::compact_error(r#"requesting https://doh.pub:443/dns-query?dns=SECRET payload"#);
        assert!(compact.contains("https://doh.pub:443/dns-query?<query-redacted>"));
        assert!(!compact.contains("SECRET"));
    }

    #[test]
    fn parses_proxy_timeout_failure() {
        let line = r#"time=\"x\" level=warning msg=\"[TCP] dial 雪山 Link (match DomainKeyword/github) 198.18.0.1:55341(twinkstar.exe) --> alive.github.com:443 error: tw1.example.cc:16000 connect error: context deadline exceeded\""#;
        let parsed = parse_failure(line).expect("failure line should parse");
        assert_eq!(parsed.network, "TCP");
        assert_eq!(parsed.outbound, "雪山 Link");
        assert_eq!(parsed.rule.as_deref(), Some("DomainKeyword/github"));
        assert_eq!(parsed.process.as_deref(), Some("twinkstar.exe"));
        assert_eq!(parsed.target, "alive.github.com:443");
        assert_eq!(parsed.error_family, "timeout");
        assert_eq!(parsed.stage, "proxy_upstream");
    }

    #[test]
    fn parses_direct_dns_failure() {
        let line = r#"[TCP] dial DIRECT (match DomainSuffix/cn) 198.18.0.1:52402(wpscloudsvr.exe) --> account.wps.cn:443 error: dns resolve failed: context deadline exceeded"#;
        let parsed = parse_failure(line).expect("failure line should parse");
        assert_eq!(parsed.outbound, "DIRECT");
        assert_eq!(parsed.error_family, "dns");
        assert_eq!(parsed.stage, "dns");
    }

    #[test]
    fn parses_selected_route_and_global_route() {
        let selected = parse_route(r#"[TCP] 198.18.0.1:50696(twinkstar.exe) --> r.bing.com:443 match DomainKeyword(bing) using CVR-当前选择[🇹🇼台湾静态三网|家宽3]"#)
            .expect("selected route should parse");
        assert_eq!(selected.outbound, "CVR-当前选择");
        assert_eq!(selected.selected_hint.as_deref(), Some("🇹🇼台湾静态三网|家宽3"));
        assert_eq!(selected.target, "r.bing.com:443");

        let global = parse_route(r#"[TCP] 198.18.0.1:57701 --> r.bing.com:443 using GLOBAL"#)
            .expect("global route should parse");
        assert_eq!(global.outbound, "GLOBAL");
        assert!(global.selected_hint.is_none());
    }

    #[test]
    fn classifies_windows_network_and_socket_failures() {
        assert_eq!(
            classify_error(
                "dial tcp 1.1.1.1:443: connectex: A socket operation was attempted to an unreachable host.",
                "DIRECT"
            ),
            ("network_unreachable", "direct_destination")
        );
        assert_eq!(
            classify_error(
                "connectex: Only one usage of each socket address (protocol/network address/port) is normally permitted.",
                "Proxy"
            ),
            ("socket_exhaustion", "outbound_transport")
        );
    }

    #[test]
    fn detects_group_health_check_signal() {
        assert_eq!(
            parse_health_check_group("because 自动选择 failed multiple times, active health check").as_deref(),
            Some("自动选择")
        );
    }

    #[test]
    fn churn_requires_repeated_connections_to_same_target() {
        let event = RouteEvent {
            network: "TCP",
            outbound: "GLOBAL".to_string(),
            selected_hint: None,
            process: Some("browser.exe".to_string()),
            target: "r.bing.com:443".to_string(),
        };
        let now = Instant::now();
        let mut bucket = ChurnBucket::new(&event, now, 1);
        for index in 1..24 {
            bucket.observe(&event, index);
        }
        assert!(bucket.suspicious());
    }
}
