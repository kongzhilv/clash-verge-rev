from pathlib import Path

path = Path('src-tauri/src/core/outbound_diagnostics.rs')
text = path.read_text(encoding='utf-8')
old = '''fn compact_error(error: &str) -> String {
    error
        .replace(['\\r', '\\n', '\\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(SAMPLE_ERROR_MAX_CHARS)
        .collect()
}
'''
new = '''fn redact_url_query(token: &str) -> String {
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
    let normalized = error.replace(['\\r', '\\n', '\\t'], " ");
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
'''
if text.count(old) != 1:
    raise SystemExit('compact_error anchor mismatch')
text = text.replace(old, new)
anchor = '#[cfg(test)]\nmod tests {'
if text.count(anchor) != 1:
    raise SystemExit('tests anchor mismatch')
text = text.replace(anchor, '#[cfg(test)]\n#[allow(clippy::expect_used)]\nmod tests {')
insert = '''
    #[test]
    fn error_samples_redact_url_queries() {
        let compact = super::compact_error(
            r#"requesting https://doh.pub:443/dns-query?dns=SECRET payload"#,
        );
        assert!(compact.contains("https://doh.pub:443/dns-query?<query-redacted>"));
        assert!(!compact.contains("SECRET"));
    }
'''
anchor2 = '    #[test]\n    fn parses_proxy_timeout_failure() {'
if text.count(anchor2) != 1:
    raise SystemExit('test insertion anchor mismatch')
text = text.replace(anchor2, insert + '\n' + anchor2)
path.write_text(text, encoding='utf-8')
