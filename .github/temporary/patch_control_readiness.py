from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


feat_path = Path("src-tauri/src/feat/clash.rs")
feat = feat_path.read_text(encoding="utf-8")
feat = replace_once(
    feat,
    "use std::sync::Arc;",
    "use std::{sync::Arc, time::Duration};",
    "feat import",
)

anchor = """});\n\n/// Restart the Clash core\n"""
helper = r''' });

const MIHOMO_CONTROL_MAX_ATTEMPTS: usize = 6;
const MIHOMO_CONTROL_RETRY_DELAYS_MS: [u64; MIHOMO_CONTROL_MAX_ATTEMPTS - 1] = [50, 100, 150, 250, 400];

fn classify_mihomo_control_error(error: &str) -> &'static str {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("decoding response body") {
        "decode"
    } else if normalized.contains("named pipe") || normalized.contains("local socket") {
        "transport"
    } else if normalized.contains("timed out") || normalized.contains("timeout") {
        "timeout"
    } else if normalized.contains("connection") {
        "connection"
    } else {
        "other"
    }
}

/// Read Mihomo's live mode through the control API with a short, bounded
/// readiness retry window. Service-mode startup can report the process as
/// started slightly before /configs is consistently decodable on the named
/// pipe. Re-acquiring the plugin guard for every attempt also avoids keeping a
/// long-lived read guard while sleeping between retries.
pub async fn read_live_mihomo_mode(stage: &str) -> Result<String, String> {
    let started = std::time::Instant::now();

    for attempt in 1..=MIHOMO_CONTROL_MAX_ATTEMPTS {
        let result = {
            let mihomo = handle::Handle::mihomo().await;
            mihomo.get_base_config().await
        };

        match result {
            Ok(base) => {
                let actual: String = base.mode.to_string().into();
                if attempt > 1 {
                    diagnostics::info(
                        "mihomo-control",
                        "control-read-recovered",
                        json!({
                            "stage": stage,
                            "attempt": attempt,
                            "max_attempts": MIHOMO_CONTROL_MAX_ATTEMPTS,
                            "elapsed_ms": started.elapsed().as_millis(),
                            "actual_mode": actual.as_str(),
                        }),
                    );
                }
                return Ok(actual);
            }
            Err(err) => {
                let error: String = err.to_string().into();
                let error_kind = classify_mihomo_control_error(error.as_str());
                if attempt == MIHOMO_CONTROL_MAX_ATTEMPTS {
                    diagnostics::warn(
                        "mihomo-control",
                        "control-read-exhausted",
                        json!({
                            "stage": stage,
                            "attempt": attempt,
                            "max_attempts": MIHOMO_CONTROL_MAX_ATTEMPTS,
                            "elapsed_ms": started.elapsed().as_millis(),
                            "error_kind": error_kind,
                            "error": error.as_str(),
                        }),
                    );
                    return Err(error);
                }

                let delay_ms = MIHOMO_CONTROL_RETRY_DELAYS_MS[attempt - 1];
                diagnostics::info(
                    "mihomo-control",
                    "control-read-retry",
                    json!({
                        "stage": stage,
                        "attempt": attempt,
                        "max_attempts": MIHOMO_CONTROL_MAX_ATTEMPTS,
                        "elapsed_ms": started.elapsed().as_millis(),
                        "retry_delay_ms": delay_ms,
                        "error_kind": error_kind,
                        "error": error.as_str(),
                    }),
                );
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
        }
    }

    Err("Mihomo control API readiness probe exhausted".into())
}

/// Restart the Clash core
'''
if anchor not in feat:
    raise SystemExit("helper insertion anchor missing")
feat = feat.replace(anchor, helper, 1)

old_read = r'''async fn read_mihomo_mode(success_event: &str, failure_event: &str) -> Option<String> {
    let mihomo = handle::Handle::mihomo().await;
    let result = mihomo.get_base_config().await;
    drop(mihomo);
    match result {
        Ok(base) => {
            let actual: String = base.mode.to_string().into();
            diagnostics::info("mode", success_event, json!({"actual": actual.as_str()}));
            Some(actual)
        }
        Err(err) => {
            diagnostics::warn("mode", failure_event, json!({"error": err.to_string()}));
            None
        }
    }
}
'''
new_read = r'''async fn read_mihomo_mode(success_event: &str, failure_event: &str) -> Option<String> {
    match read_live_mihomo_mode(success_event).await {
        Ok(actual) => {
            diagnostics::info("mode", success_event, json!({"actual": actual.as_str()}));
            Some(actual)
        }
        Err(error) => {
            diagnostics::warn("mode", failure_event, json!({"error": error.as_str()}));
            None
        }
    }
}
'''
feat = replace_once(feat, old_read, new_read, "read_mihomo_mode")

verify_start = feat.index("pub async fn verify_running_mode_state(stage: &str)")
block_start = feat.index("    let mihomo = handle::Handle::mihomo().await;", verify_start)
block_end = feat.index("    let Some(expected) = expected else {", block_start)
new_verify_read = r'''    let actual = match read_live_mihomo_mode(stage).await {
        Ok(actual) => actual,
        Err(error) => {
            diagnostics::warn(
                "mode",
                "active-mode-readback-failed",
                json!({
                    "stage": stage,
                    "saved": saved.as_deref(),
                    "runtime": runtime.as_deref(),
                    "error": error.as_str(),
                }),
            );
            return Ok(());
        }
    };

    diagnostics::info(
        "mode",
        "active-mode-readback",
        json!({
            "stage": stage,
            "saved": saved.as_deref(),
            "runtime": runtime.as_deref(),
            "actual": actual.as_str(),
        }),
    );

    if actual == "global" {
        record_global_selection(Some(stage)).await;
    }

'''
feat = feat[:block_start] + new_verify_read + feat[block_end:]

verify_start = feat.index("pub async fn verify_running_mode_state(stage: &str)")
patch_start = feat.index('    let patch = json!({"mode": expected});', verify_start)
match_start = feat.index("    match mihomo.get_base_config().await {", patch_start)
new_self_heal_prefix = r'''    let patch = json!({"mode": expected});
    let patch_result = {
        let mihomo = handle::Handle::mihomo().await;
        mihomo.patch_base_config(&patch).await
    };
    if let Err(err) = patch_result {
        diagnostics::error(
            "mode",
            "active-mode-self-heal-failed",
            json!({"stage": stage, "expected": expected, "error": err.to_string()}),
        );
        return Err(format!("Failed to restore Mihomo mode to {expected}: {err}").into());
    }

    let self_heal_readback = {
        let mihomo = handle::Handle::mihomo().await;
        mihomo.get_base_config().await
    };

    match self_heal_readback {
'''
feat = feat[:patch_start] + new_self_heal_prefix + feat[match_start + len("    match mihomo.get_base_config().await {\n"):]
feat_path.write_text(feat, encoding="utf-8")


cmd_path = Path("src-tauri/src/cmd/clash.rs")
cmd = cmd_path.read_text(encoding="utf-8")
get_mode_start = cmd.index("pub async fn get_clash_mode()")
if_start = cmd.index("    if core_running {", get_mode_start)
if_end = cmd.index("\n    Ok(saved)", if_start)
new_ui_read = r'''    if core_running {
        match feat::read_live_mihomo_mode("ui-get-clash-mode").await {
            Ok(actual) => {
                diagnostics::info(
                    "mode",
                    "ui-mode-readback",
                    serde_json::json!({
                        "saved": saved.as_deref(),
                        "actual": actual.as_str(),
                    }),
                );
                return Ok(Some(actual));
            }
            Err(error) => diagnostics::warn(
                "mode",
                "ui-mode-readback-failed",
                serde_json::json!({
                    "saved": saved.as_deref(),
                    "error": error.as_str(),
                }),
            ),
        }
    }
'''
cmd = cmd[:if_start] + new_ui_read + cmd[if_end:]

cmd = replace_once(
    cmd,
    "async fn prepare_runtime_before_start() -> CmdResult {",
    "async fn prepare_runtime_before_start(stage: &str) -> CmdResult {",
    "prepare runtime signature",
)
prep_start = cmd.index("async fn prepare_runtime_before_start(stage: &str)")
prep_end = cmd.index("\nasync fn verify_mode_after_start", prep_start)
prep = cmd[prep_start:prep_end]
prep = prep.replace('serde_json::json!({}),', 'serde_json::json!({"stage": stage}),')
cmd = cmd[:prep_start] + prep + cmd[prep_end:]

old_start_core = r'''#[tauri::command]
pub async fn start_core() -> CmdResult {
    prepare_runtime_before_start().await?;
    let result = CoreManager::global().start_core().await.stringify_err();
    if result.is_ok() {
        verify_mode_after_start("start-core").await?;
        handle::Handle::refresh_clash();
    }
    result
}
'''
new_start_core = r'''#[tauri::command]
pub async fn start_core() -> CmdResult {
    let stage = "start-core";
    prepare_runtime_before_start(stage).await?;
    diagnostics::info("core", "start-requested", serde_json::json!({"stage": stage}));
    let result = CoreManager::global().start_core().await.stringify_err();
    if result.is_ok() {
        diagnostics::info("core", "start-succeeded", serde_json::json!({"stage": stage}));
        verify_mode_after_start(stage).await?;
        handle::Handle::refresh_clash();
    } else {
        diagnostics::error("core", "start-failed", serde_json::json!({"stage": stage}));
    }
    result
}
'''
cmd = replace_once(cmd, old_start_core, new_start_core, "start_core")

old_start_proxy = r'''#[tauri::command]
pub async fn start_proxy() -> CmdResult {
    prepare_runtime_before_start().await?;
    CoreManager::global().start_core().await.stringify_err()?;
    verify_mode_after_start("start-proxy").await?;

    if let Err(error) = Sysopt::global().update_sysproxy().await {
'''
new_start_proxy = r'''#[tauri::command]
pub async fn start_proxy() -> CmdResult {
    let stage = "start-proxy";
    prepare_runtime_before_start(stage).await?;
    diagnostics::info("core", "start-requested", serde_json::json!({"stage": stage}));
    if let Err(error) = CoreManager::global().start_core().await {
        diagnostics::error(
            "core",
            "start-failed",
            serde_json::json!({"stage": stage, "error": error.to_string()}),
        );
        return Err(error.to_string().into());
    }
    diagnostics::info("core", "start-succeeded", serde_json::json!({"stage": stage}));
    verify_mode_after_start(stage).await?;

    if let Err(error) = Sysopt::global().update_sysproxy().await {
'''
cmd = replace_once(cmd, old_start_proxy, new_start_proxy, "start_proxy")
cmd_path.write_text(cmd, encoding="utf-8")

print("patched control API readiness and targeted lifecycle diagnostics")
