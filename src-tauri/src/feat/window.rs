use crate::config::Config;
use crate::core::{CoreManager, diagnostics, handle, manager::RunningMode, sysopt};
use crate::module::lightweight;
use crate::utils;
use crate::utils::window_manager::WindowManager;
use clash_verge_logging::{Type, logging};
use tokio::time::{Duration, timeout};

pub async fn open_or_close_dashboard() {
    if lightweight::is_in_lightweight_mode() {
        let _ = lightweight::exit_lightweight_mode().await;
        return;
    }

    let result = WindowManager::toggle_main_window().await;
    logging!(info, Type::Window, "Window toggle result: {result:?}");
}

pub async fn quit() {
    logging!(debug, Type::System, "启动退出流程");
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
    app_handle.exit(if cleanup_result { 0 } else { 1 });
}

pub async fn clean_async() -> bool {
    logging!(info, Type::System, "开始执行异步清理操作...");

    // 重置系统代理
    let proxy_task = tokio::task::spawn(async {
        let sys_proxy_enabled = Config::verge().await.data_arc().enable_system_proxy.unwrap_or(false);
        if !sys_proxy_enabled {
            logging!(info, Type::Window, "系统代理未启用，跳过重置");
            return true;
        }

        logging!(info, Type::Window, "开始重置系统代理...");
        match timeout(Duration::from_millis(1500), sysopt::Sysopt::global().reset_sysproxy()).await {
            Ok(Ok(_)) => {
                logging!(info, Type::Window, "系统代理已重置");
                true
            }
            Ok(Err(e)) => {
                logging!(warn, Type::Window, "Warning: 重置系统代理失败: {e}");
                false
            }
            Err(_) => {
                logging!(warn, Type::Window, "Warning: 重置系统代理超时，继续退出");
                false
            }
        }
    });

    // 关闭 Tun 模式 + 停止核心服务
    let core_task = tokio::task::spawn(async {
        logging!(info, Type::System, "disable tun");
        let tun_enabled = Config::verge().await.data_arc().enable_tun_mode.unwrap_or(false);
        let core_running = !matches!(
            CoreManager::global().get_running_mode().as_ref(),
            RunningMode::NotRunning
        );

        // Karing .22 WinRT topology is restored in two phases. First stop the
        // Mihomo-backed hotspot while the TUN ConnectionProfile still exists. This
        // prevents Windows from forwarding hotspot traffic into an adapter that is
        // being destroyed. After the core/TUN is gone we restart tethering from the
        // best physical ConnectionProfile.
        #[cfg(target_os = "windows")]
        let winrt_suspend_success = match crate::core::windows_hotspot_winrt::suspend_for_tun_teardown("shutdown").await {
            Ok(suspended) => {
                diagnostics::info(
                    "shutdown",
                    "windows-winrt-hotspot-suspend-completed",
                    serde_json::json!({"suspended": suspended}),
                );
                true
            }
            Err(error) => {
                diagnostics::error(
                    "shutdown",
                    "windows-winrt-hotspot-suspend-failed",
                    serde_json::json!({
                        "error": error.to_string(),
                        "action": "abort-explicit-tun-core-teardown-preserve-working-topology",
                    }),
                );
                false
            }
        };
        #[cfg(not(target_os = "windows"))]
        let winrt_suspend_success = true;

        if !winrt_suspend_success {
            diagnostics::error(
                "shutdown",
                "windows-winrt-hotspot-teardown-aborted",
                serde_json::json!({
                    "reason": "winrt-hotspot-suspend-failed",
                    "tun_teardown_attempted": false,
                    "core_stop_attempted": false,
                }),
            );
            return false;
        }

        // The leased ICS PUBLIC side is the Mihomo TUN adapter. Restore Windows ICS
        // before asking Mihomo to destroy that adapter, otherwise the original PUBLIC
        // role may no longer be recoverable during shutdown/restart. Do not wrap the
        // blocking COM restore in a Tokio timeout: timing out the future cannot cancel
        // spawn_blocking and would race an in-flight rollback against TUN destruction.
        #[cfg(target_os = "windows")]
        let ics_restore_success = match crate::core::windows_hotspot_ics::restore_now("shutdown").await {
            Ok(restored) => {
                diagnostics::info(
                    "shutdown",
                    "windows-ics-restore-completed",
                    serde_json::json!({"restored": restored}),
                );
                true
            }
            Err(error) => {
                diagnostics::error(
                    "shutdown",
                    "windows-ics-restore-failed",
                    serde_json::json!({
                        "error": error.to_string(),
                        "action": "abort-explicit-tun-core-teardown-preserve-snapshot",
                    }),
                );
                false
            }
        };
        #[cfg(not(target_os = "windows"))]
        let ics_restore_success = true;

        if !ics_restore_success {
            diagnostics::error(
                "shutdown",
                "windows-ics-teardown-aborted",
                serde_json::json!({
                    "reason": "ics-restore-failed",
                    "tun_teardown_attempted": false,
                    "core_stop_attempted": false,
                }),
            );
            return false;
        }

        if tun_enabled && core_running {
            let disable_tun = serde_json::json!({ "tun": { "enable": false } });

            logging!(info, Type::System, "send disable tun request to mihomo");
            match timeout(
                Duration::from_millis(1000),
                handle::Handle::mihomo().await.patch_base_config(&disable_tun),
            )
            .await
            {
                Ok(Ok(_)) => {
                    logging!(info, Type::Window, "TUN模式已禁用");
                }
                Ok(Err(e)) => {
                    logging!(warn, Type::Window, "Warning: 禁用TUN模式失败: {e}");
                    diagnostics::warn(
                        "shutdown",
                        "tun-disable-failed",
                        serde_json::json!({"error": e.to_string()}),
                    );
                }
                Err(_) => {
                    logging!(
                        warn,
                        Type::Window,
                        "Warning: 禁用TUN模式超时（可能系统正在关机），继续退出流程"
                    );
                    diagnostics::warn("shutdown", "tun-disable-timeout", serde_json::json!({}));
                }
            }
        } else if tun_enabled {
            logging!(info, Type::Window, "核心已停止，跳过 TUN API 禁用请求");
            diagnostics::info("shutdown", "tun-disable-skipped-core-stopped", serde_json::json!({}));
        }

        #[cfg(target_os = "windows")]
        let stop_timeout = Duration::from_secs(2);
        #[cfg(not(target_os = "windows"))]
        let stop_timeout = Duration::from_secs(3);

        logging!(info, Type::System, "stop core");
        let core_stop_success = match timeout(stop_timeout, CoreManager::global().stop_core()).await {
            Ok(_) => {
                logging!(info, Type::Window, "core已停止");
                true
            }
            Err(_) => {
                logging!(
                    warn,
                    Type::Window,
                    "Warning: 停止core超时（可能系统正在关机），继续退出"
                );
                false
            }
        };

        #[cfg(target_os = "windows")]
        let winrt_restore_success = match crate::core::windows_hotspot_winrt::restore_after_tun_teardown("shutdown").await {
            Ok(restored) => {
                diagnostics::info(
                    "shutdown",
                    "windows-winrt-hotspot-restore-completed",
                    serde_json::json!({"restored": restored}),
                );
                true
            }
            Err(error) => {
                diagnostics::error(
                    "shutdown",
                    "windows-winrt-hotspot-restore-failed",
                    serde_json::json!({
                        "error": error.to_string(),
                        "action": "leave-hotspot-off-instead-of-binding-to-destroyed-tun",
                    }),
                );
                false
            }
        };
        #[cfg(not(target_os = "windows"))]
        let winrt_restore_success = true;

        winrt_suspend_success && ics_restore_success && core_stop_success && winrt_restore_success
    });

    // DNS恢复（仅macOS）
    let dns_task = tokio::task::spawn(async {
        #[cfg(target_os = "macos")]
        match timeout(
            Duration::from_millis(1000),
            crate::utils::resolve::dns::restore_public_dns(),
        )
        .await
        {
            Ok(_) => {
                logging!(info, Type::Window, "DNS设置已恢复");
                true
            }
            Err(_) => {
                logging!(warn, Type::Window, "Warning: 恢复DNS设置超时");
                false
            }
        }
        #[cfg(not(target_os = "macos"))]
        true
    });

    // 并行执行清理任务
    let (proxy_result, core_result, dns_result) = tokio::join!(proxy_task, core_task, dns_task);

    let proxy_success = proxy_result.unwrap_or_default();
    let core_success = core_result.unwrap_or_default();
    let dns_success = dns_result.unwrap_or_default();

    let all_success = proxy_success && core_success && dns_success;

    logging!(
        info,
        Type::System,
        "异步关闭操作完成 - 代理: {}, 核心: {}, DNS: {}, 总体: {}",
        proxy_success,
        core_success,
        dns_success,
        all_success
    );

    all_success
}

#[cfg(target_os = "macos")]
pub async fn hide() {
    use crate::module::lightweight::add_light_weight_timer;

    let enable_auto_light_weight_mode = Config::verge()
        .await
        .data_arc()
        .enable_auto_light_weight_mode
        .unwrap_or(false);

    if enable_auto_light_weight_mode {
        add_light_weight_timer().await;
    }

    if let Some(window) = WindowManager::get_main_window()
        && window.is_visible().unwrap_or(false)
    {
        let _ = window.hide();
    }
    handle::Handle::global().set_activation_policy_accessory();
}