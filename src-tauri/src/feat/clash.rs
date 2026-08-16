use crate::{
    config::Config,
    core::{CoreManager, diagnostics, handle, manager::RunningMode, tray},
    feat::clean_async,
    process::AsyncHandler,
    utils,
};
use bytes::BytesMut;
use clash_verge_logging::{Type, logging};
use once_cell::sync::Lazy;
use serde_json::json;
use serde_yaml_ng::{Mapping, Value};
use smartstring::alias::String;
use std::sync::Arc;

#[allow(clippy::expect_used)]
static TLS_CONFIG: Lazy<Arc<rustls::ClientConfig>> = Lazy::new(|| {
    let root_store = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("Failed to set TLS versions")
        .with_root_certificates(root_store)
        .with_no_client_auth();
    Arc::new(config)
});

/// Restart the Clash core
pub async fn restart_clash_core() {
    match CoreManager::global().restart_core().await {
        Ok(_) => {
            handle::Handle::refresh_clash();
            handle::Handle::notice_message("set_config::ok", "ok");
        }
        Err(err) => {
            handle::Handle::notice_message("set_config::error", format!("{err}"));
            logging!(error, Type::Core, "{err}");
        }
    }
}

/// Restart the application
pub async fn restart_app() {
    logging!(debug, Type::System, "启动重启应用流程");
    // 设置退出标志
    handle::Handle::global().set_is_exiting();

    utils::server::shutdown_embedded_server();
    Config::apply_all_and_save_file().await;

    logging!(info, Type::System, "开始异步清理资源");
    let cleanup_result = clean_async().await;

    logging!(
        info,
        Type::System,
        "资源清理完成，退出代码: {}",
        if cleanup_result { 0 } else { 1 }
    );

    let app_handle = handle::Handle::app_handle();
    app_handle.restart();
}

fn after_change_clash_mode() {
    AsyncHandler::spawn(move || async {
        let mihomo = handle::Handle::mihomo().await;
        match mihomo.get_connections().await {
            Ok(connections) => {
                if let Some(connections_array) = connections.connections {
                    for connection in connections_array {
                        let _ = mihomo.close_connection(&connection.id).await;
                    }
                    drop(mihomo);
                }
            }
            Err(err) => {
                logging!(error, Type::Core, "Failed to get connections: {err}");
            }
        }
    });
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

    let core_running = !matches!(
        CoreManager::global().get_running_mode().as_ref(),
        RunningMode::NotRunning
    );
    let clash = Config::clash().await;
    let saved_before = clash.data_arc().get_mode();

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

    let mut mihomo_before: Option<String> = None;
    if core_running {
        let mihomo = handle::Handle::mihomo().await;
        match mihomo.get_base_config().await {
            Ok(base) => {
                let actual = base.mode.to_string();
                diagnostics::info(
                    "mode",
                    "mode-change-readback-before",
                    json!({"actual": actual}),
                );
                mihomo_before = Some(actual.into());
            }
            Err(err) => {
                diagnostics::warn(
                    "mode",
                    "mode-change-readback-before-failed",
                    json!({"error": err.to_string()}),
                );
            }
        }

        let patch = json!({"mode": requested_mode.as_str()});
        if let Err(err) = mihomo.patch_base_config(&patch).await {
            diagnostics::error(
                "mode",
                "mode-change-patch-failed",
                json!({"requested": requested_mode.as_str(), "error": err.to_string()}),
            );
            logging!(error, Type::Core, "{err}");
            return Err(err.to_string().into());
        }
        diagnostics::info(
            "mode",
            "mode-change-patch-succeeded",
            json!({"requested": requested_mode.as_str()}),
        );

        match mihomo.get_base_config().await {
            Ok(base) => {
                let actual = base.mode.to_string();
                diagnostics::info(
                    "mode",
                    "mode-change-readback",
                    json!({"requested": requested_mode.as_str(), "actual": actual}),
                );
                if actual != requested_mode.as_str() {
                    diagnostics::error(
                        "mode",
                        "mode-change-readback-mismatch",
                        json!({"requested": requested_mode.as_str(), "actual": actual}),
                    );
                    if let Some(previous) = mihomo_before.as_deref() {
                        let rollback = json!({"mode": previous});
                        let rollback_result = mihomo.patch_base_config(&rollback).await;
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
                    return Err(format!(
                        "Mihomo mode readback mismatch: requested {requested_mode}, got {actual}"
                    )
                    .into());
                }
            }
            Err(err) => diagnostics::warn(
                "mode",
                "mode-change-readback-failed",
                json!({"requested": requested_mode.as_str(), "error": err.to_string()}),
            ),
        }

        if requested_mode == "global" {
            match mihomo.get_proxy_by_name("GLOBAL").await {
                Ok(global) => {
                    let selected = global.now.as_deref();
                    diagnostics::info(
                        "mode",
                        "global-selection-readback",
                        json!({
                            "selected": selected,
                            "alive": global.alive,
                            "type": global.proxy_type.as_str(),
                        }),
                    );
                    if selected.is_some_and(|name| name.eq_ignore_ascii_case("DIRECT")) {
                        diagnostics::warn(
                            "mode",
                            "global-direct-selected",
                            json!({"selected": selected}),
                        );
                    }
                }
                Err(err) => diagnostics::warn(
                    "mode",
                    "global-selection-readback-failed",
                    json!({"error": err.to_string()}),
                ),
            }
        }
    } else {
        logging!(
            info,
            Type::Core,
            "core is stopped; staging Clash mode {requested_mode} for the next start"
        );
    }

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

        if core_running {
            if let Some(previous) = mihomo_before.as_deref() {
                let mihomo = handle::Handle::mihomo().await;
                let rollback = json!({"mode": previous});
                let rollback_result = mihomo.patch_base_config(&rollback).await;
                diagnostics::warn(
                    "mode",
                    "mode-change-core-rollback",
                    json!({
                        "target": previous,
                        "succeeded": rollback_result.is_ok(),
                        "error": rollback_result.err().map(|error| error.to_string()),
                    }),
                );
            }
        }

        return Err(format!("Failed to persist Clash mode {requested_mode}: {err}").into());
    }

    clash.apply();
    let saved_after = clash.data_arc().get_mode();
    diagnostics::info(
        "mode",
        "mode-change-persisted",
        json!({
            "requested": requested_mode.as_str(),
            "saved_after": saved_after.as_deref(),
        }),
    );

    if !core_running {
        match CoreManager::global().update_config_checked().await {
            Ok(()) => diagnostics::info(
                "mode",
                "mode-change-runtime-staged",
                json!({"requested": requested_mode.as_str()}),
            ),
            Err(err) => {
                diagnostics::error(
                    "mode",
                    "mode-change-runtime-stage-failed",
                    json!({"requested": requested_mode.as_str(), "error": err.to_string()}),
                );
                return Err(format!(
                    "Clash mode was saved, but Runtime regeneration failed: {err}"
                )
                .into());
            }
        }
    }

    handle::Handle::refresh_clash();
    tray::Tray::global().update_menu_and_icon().await;

    let is_auto_close_connection = Config::verge().await.data_arc().auto_close_connection.unwrap_or(false);
    if core_running && is_auto_close_connection {
        after_change_clash_mode();
    }

    Ok(())
}

/// Compare the persisted app mode, generated Runtime mode and Mihomo's live
/// mode. A live mismatch is repaired once using the app's persisted mode as
/// the authority. Readback failures are diagnostic-only so a transient control
/// API delay does not turn into a proxy startup failure.
pub async fn verify_running_mode_state(stage: &str) -> Result<(), String> {
    if matches!(
        CoreManager::global().get_running_mode().as_ref(),
        RunningMode::NotRunning
    ) {
        return Ok(());
    }

    let saved = Config::clash().await.data_arc().get_mode();
    let runtime = Config::runtime()
        .await
        .latest_arc()
        .config
        .as_ref()
        .and_then(|config| config.get("mode"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let expected = saved.as_deref().or(runtime.as_deref());

    if saved.as_deref() != runtime.as_deref() {
        diagnostics::error(
            "mode",
            "saved-runtime-mode-mismatch",
            json!({
                "stage": stage,
                "saved": saved.as_deref(),
                "runtime": runtime.as_deref(),
            }),
        );
    }

    let mihomo = handle::Handle::mihomo().await;
    let base = match mihomo.get_base_config().await {
        Ok(base) => base,
        Err(err) => {
            diagnostics::warn(
                "mode",
                "active-mode-readback-failed",
                json!({
                    "stage": stage,
                    "saved": saved.as_deref(),
                    "runtime": runtime.as_deref(),
                    "error": err.to_string(),
                }),
            );
            return Ok(());
        }
    };
    let actual = base.mode.to_string();

    diagnostics::info(
        "mode",
        "active-mode-readback",
        json!({
            "stage": stage,
            "saved": saved.as_deref(),
            "runtime": runtime.as_deref(),
            "actual": actual,
        }),
    );

    if actual == "global" {
        match mihomo.get_proxy_by_name("GLOBAL").await {
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

    let Some(expected) = expected else {
        return Ok(());
    };
    if actual == expected {
        return Ok(());
    }

    diagnostics::error(
        "mode",
        "active-mode-mismatch",
        json!({"stage": stage, "expected": expected, "actual": actual}),
    );
    let patch = json!({"mode": expected});
    if let Err(err) = mihomo.patch_base_config(&patch).await {
        diagnostics::error(
            "mode",
            "active-mode-self-heal-failed",
            json!({"stage": stage, "expected": expected, "error": err.to_string()}),
        );
        return Err(format!("Failed to restore Mihomo mode to {expected}: {err}").into());
    }

    match mihomo.get_base_config().await {
        Ok(base) if base.mode.to_string() == expected => {
            diagnostics::warn(
                "mode",
                "active-mode-self-healed",
                json!({"stage": stage, "expected": expected}),
            );
            Ok(())
        }
        Ok(base) => {
            let actual_after = base.mode.to_string();
            diagnostics::error(
                "mode",
                "active-mode-self-heal-mismatch",
                json!({
                    "stage": stage,
                    "expected": expected,
                    "actual": actual_after,
                }),
            );
            Err(format!(
                "Mihomo mode remained {actual_after} after restoring expected mode {expected}"
            )
            .into())
        }
        Err(err) => {
            diagnostics::warn(
                "mode",
                "active-mode-self-heal-readback-failed",
                json!({"stage": stage, "expected": expected, "error": err.to_string()}),
            );
            Ok(())
        }
    }
}

/// Test delay to a URL through proxy.
/// HTTPS: measures TLS handshake time. HTTP: measures HEAD round-trip time.
pub async fn test_delay(url: String) -> anyhow::Result<u32> {
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;
    use tokio::time::Instant;

    let parsed = tauri::Url::parse(&url)?;
    let is_https = parsed.scheme() == "https";
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("Invalid URL: no host"))?
        .to_string();
    let port = parsed.port().unwrap_or(if is_https { 443 } else { 80 });

    let verge = Config::verge().await.latest_arc();
    let proxy_enabled = verge.enable_system_proxy.unwrap_or(false) || verge.enable_tun_mode.unwrap_or(false);
    let proxy_port = if proxy_enabled {
        Some(match verge.verge_mixed_port {
            Some(p) => p,
            None => Config::clash().await.data_arc().get_mixed_port(),
        })
    } else {
        None
    };

    tokio::time::timeout(Duration::from_secs(10), async {
        let start = Instant::now();
        let mut buf = BytesMut::with_capacity(1024);
        if is_https {
            let stream = match proxy_port {
                Some(pp) => {
                    let mut s = TcpStream::connect(format!("127.0.0.1:{pp}")).await?;
                    s.write_all(format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n").as_bytes())
                        .await?;
                    s.read_buf(&mut buf).await?;
                    if !buf.windows(3).any(|w| w == b"200") {
                        return Err(anyhow::anyhow!("Proxy CONNECT failed"));
                    }
                    s
                }
                None => TcpStream::connect(format!("{host}:{port}")).await?,
            };
            let connector = tokio_rustls::TlsConnector::from(Arc::clone(&TLS_CONFIG));
            let server_name = rustls::pki_types::ServerName::try_from(host.as_str())
                .map_err(|_| anyhow::anyhow!("Invalid DNS name: {host}"))?
                .to_owned();
            connector.connect(server_name, stream).await?;
        } else {
            let (mut stream, req) = match proxy_port {
                Some(pp) => (
                    TcpStream::connect(format!("127.0.0.1:{pp}")).await?,
                    format!("HEAD {url} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"),
                ),
                None => (
                    TcpStream::connect(format!("{host}:{port}")).await?,
                    format!("HEAD / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"),
                ),
            };
            stream.write_all(req.as_bytes()).await?;
            let _ = stream.read(&mut buf).await?;
        }

        // frontend treats 0 as timeout
        Ok((start.elapsed().as_millis() as u32).max(1))
    })
    .await
    .unwrap_or(Ok(10000u32))
}
