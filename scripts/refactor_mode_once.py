from pathlib import Path

cmd = Path("src-tauri/src/cmd/clash.rs")
s = cmd.read_text()
old = "    Ok(saved.map(Into::into))\n}"
new = "    Ok(saved)\n}"
if old not in s:
    raise SystemExit("cmd get_clash_mode replacement anchor missing")
cmd.write_text(s.replace(old, new, 1))

feat = Path("src-tauri/src/feat/clash.rs")
s = feat.read_text()
start = s.index("pub async fn change_clash_mode(mode: String) -> Result<(), String> {")
end = s.index("/// Compare the persisted app mode, generated Runtime mode and Mihomo's live")
replacement = r'''fn core_is_running() -> bool {
    !matches!(
        CoreManager::global().get_running_mode().as_ref(),
        RunningMode::NotRunning
    )
}

async fn rollback_mihomo_mode(previous: &str) {
    let rollback = json!({"mode": previous});
    let mihomo = handle::Handle::mihomo().await;
    let rollback_result = mihomo.patch_base_config(&rollback).await;
    drop(mihomo);
    diagnostics::warn(
        "mode",
        "mode-change-core-rollback",
        json!({
            "target": previous,
            "succeeded": rollback_result.is_ok(),
            "error": rollback_result.err().map(|err| err.to_string()),
        }),
    );
}

async fn read_mihomo_mode(success_event: &str, failure_event: &str) -> Option<String> {
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
            diagnostics::warn(
                "mode",
                failure_event,
                json!({"error": err.to_string()}),
            );
            None
        }
    }
}

async fn patch_mihomo_mode(requested_mode: &str) -> Result<(), String> {
    let patch = json!({"mode": requested_mode});
    let mihomo = handle::Handle::mihomo().await;
    let result = mihomo.patch_base_config(&patch).await;
    drop(mihomo);
    match result {
        Ok(()) => {
            diagnostics::info(
                "mode",
                "mode-change-patch-succeeded",
                json!({"requested": requested_mode}),
            );
            Ok(())
        }
        Err(err) => {
            diagnostics::error(
                "mode",
                "mode-change-patch-failed",
                json!({"requested": requested_mode, "error": err.to_string()}),
            );
            logging!(error, Type::Core, "{err}");
            Err(err.to_string().into())
        }
    }
}

async fn record_global_selection(stage: Option<&str>) {
    let mihomo = handle::Handle::mihomo().await;
    let result = mihomo.get_proxy_by_name("GLOBAL").await;
    drop(mihomo);
    match result {
        Ok(global) => {
            let selected = global.now.as_deref();
            diagnostics::info(
                "mode",
                "global-selection-readback",
                json!({
                    "stage": stage,
                    "selected": selected,
                    "alive": global.alive,
                    "type": global.proxy_type.as_str(),
                }),
            );
            if selected.is_some_and(|name| name.eq_ignore_ascii_case("DIRECT")) {
                diagnostics::warn(
                    "mode",
                    "global-direct-selected",
                    json!({"stage": stage, "selected": selected}),
                );
            }
        }
        Err(err) => diagnostics::warn(
            "mode",
            "global-selection-readback-failed",
            json!({"stage": stage, "error": err.to_string()}),
        ),
    }
}

async fn prepare_live_mode_change(requested_mode: &str) -> Result<Option<String>, String> {
    let previous = read_mihomo_mode(
        "mode-change-readback-before",
        "mode-change-readback-before-failed",
    )
    .await;
    patch_mihomo_mode(requested_mode).await?;

    if let Some(actual) = read_mihomo_mode(
        "mode-change-readback",
        "mode-change-readback-failed",
    )
    .await
        && actual.as_str() != requested_mode
    {
        diagnostics::error(
            "mode",
            "mode-change-readback-mismatch",
            json!({"requested": requested_mode, "actual": actual.as_str()}),
        );
        if let Some(previous) = previous.as_deref() {
            rollback_mihomo_mode(previous).await;
        }
        return Err(
            format!("Mihomo mode readback mismatch: requested {requested_mode}, got {actual}").into(),
        );
    }

    if requested_mode == "global" {
        record_global_selection(None).await;
    }
    Ok(previous)
}

async fn stage_stopped_runtime_mode(requested_mode: &str) -> Result<(), String> {
    match CoreManager::global().update_config_checked().await {
        Ok(()) => {
            diagnostics::info(
                "mode",
                "mode-change-runtime-staged",
                json!({"requested": requested_mode}),
            );
            Ok(())
        }
        Err(err) => {
            diagnostics::error(
                "mode",
                "mode-change-runtime-stage-failed",
                json!({"requested": requested_mode, "error": err.to_string()}),
            );
            Err(format!("Clash mode was saved, but Runtime regeneration failed: {err}").into())
        }
    }
}

/// Change Clash mode (rule/global/direct).
///
/// The running Mihomo state, persisted Clash config and in-memory config are
/// committed as one logical transaction. If persistence fails after Mihomo was
/// patched, the core is rolled back to its previous mode so a later Runtime
/// regeneration cannot silently disagree with the currently running core.
pub async fn change_clash_mode(mode: String) -> Result<(), String> {
    let requested_mode: String = mode.to_ascii_lowercase().into();
    if !matches!(requested_mode.as_str(), "rule" | "global" | "direct") {
        diagnostics::error(
            "mode",
            "mode-change-rejected",
            json!({"requested": requested_mode.as_str(), "reason": "unsupported-mode"}),
        );
        return Err(format!("Unsupported Clash mode: {requested_mode}").into());
    }

    let core_running = core_is_running();
    let clash = Config::clash().await;
    let saved_before = clash.data_arc().get_mode().map(String::from);
    diagnostics::info(
        "mode",
        "mode-change-requested",
        json!({
            "requested": requested_mode.as_str(),
            "saved_before": saved_before.as_deref(),
            "core_running": core_running,
        }),
    );
    logging!(debug, Type::Core, "change clash mode to {requested_mode}");

    let mihomo_before = if core_running {
        prepare_live_mode_change(requested_mode.as_str()).await?
    } else {
        logging!(
            info,
            Type::Core,
            "core is stopped; staging Clash mode {requested_mode} for the next start"
        );
        None
    };

    let mut mapping = Mapping::new();
    mapping.insert(Value::from("mode"), Value::from(requested_mode.as_str()));
    clash.edit_draft(|draft| draft.patch_config(&mapping));

    if let Err(err) = clash.latest_arc().save_config().await {
        clash.discard();
        diagnostics::error(
            "mode",
            "mode-change-persist-failed",
            json!({"requested": requested_mode.as_str(), "error": err.to_string()}),
        );
        if let Some(previous) = mihomo_before.as_deref() {
            rollback_mihomo_mode(previous).await;
        }
        return Err(format!("Failed to persist Clash mode {requested_mode}: {err}").into());
    }

    clash.apply();
    let saved_after = clash.data_arc().get_mode().map(String::from);
    diagnostics::info(
        "mode",
        "mode-change-persisted",
        json!({
            "requested": requested_mode.as_str(),
            "saved_after": saved_after.as_deref(),
        }),
    );

    if !core_running {
        stage_stopped_runtime_mode(requested_mode.as_str()).await?;
    }

    handle::Handle::refresh_clash();
    tray::Tray::global().update_menu_and_icon().await;
    let auto_close = Config::verge().await.data_arc().auto_close_connection.unwrap_or(false);
    if core_running && auto_close {
        after_change_clash_mode();
    }
    Ok(())
}

'''
feat.write_text(s[:start] + replacement + s[end:])
