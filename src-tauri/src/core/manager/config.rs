use super::{CoreManager, RunningMode};
use crate::{
    config::{Config, ConfigType, runtime::IRuntime},
    constants::timing,
    core::{
        handle,
        validate::{CoreConfigValidator, ValidationOutcome, ValidationSkipReason},
    },
    utils::{dirs, help},
};
use anyhow::{Result, anyhow};
use clash_verge_logging::{Type, logging};
use scopeguard::defer;
use smartstring::alias::String;
use std::{collections::HashSet, path::PathBuf, time::Instant};
use tauri_plugin_mihomo::Error as MihomoError;

impl CoreManager {
    pub async fn use_default_config(&self, error_key: &str, error_msg: &str) -> Result<()> {
        use crate::constants::files::RUNTIME_CONFIG;

        let runtime_path = dirs::app_home_dir()?.join(RUNTIME_CONFIG);
        let clash_config = &Config::clash().await.latest_arc().0;

        Config::runtime().await.edit_draft(|d| {
            *d = IRuntime {
                config: Some(clash_config.to_owned()),
                exists_keys: HashSet::new(),
                chain_logs: Default::default(),
            }
        });

        help::save_yaml(&runtime_path, &clash_config, Some("# Clash Verge Runtime")).await?;
        handle::Handle::notice_message(error_key, error_msg);
        Ok(())
    }

    pub async fn update_config_forced(&self) -> Result<ValidationOutcome> {
        self.update_config_with_force(true).await
    }

    pub async fn update_config_with_force(&self, force: bool) -> Result<ValidationOutcome> {
        if handle::Handle::global().is_exiting() {
            return Ok(ValidationOutcome::Skipped {
                reason: ValidationSkipReason::Exiting,
            });
        }

        if !self.try_start_config_update() {
            logging!(info, Type::Core, "Configuration update is already running");
            return Ok(ValidationOutcome::Busy);
        }
        defer! {
            self.finish_config_update();
        }

        if !force && !self.should_update_config() {
            logging!(debug, Type::Core, "Skipping config update due to debounce");
            return Ok(ValidationOutcome::Skipped {
                reason: ValidationSkipReason::Debounced,
            });
        }

        if force {
            self.set_last_update(Instant::now());
        }

        self.perform_config_update().await
    }

    pub async fn update_config_checked(&self) -> Result<()> {
        let outcome = self.update_config_forced().await?;
        if outcome.is_valid() {
            Ok(())
        } else {
            Err(anyhow!("{outcome}"))
        }
    }

    fn should_update_config(&self) -> bool {
        let now = Instant::now();
        let last = self.get_last_update();

        if let Some(last_time) = last
            && now.duration_since(*last_time) < timing::CONFIG_UPDATE_DEBOUNCE
        {
            return false;
        }

        self.set_last_update(now);
        true
    }

    async fn perform_config_update(&self) -> Result<ValidationOutcome> {
        if let Err(err) = Config::generate().await {
            let message: String = err.to_string().into();
            Config::runtime().await.discard();
            return Ok(ValidationOutcome::invalid_from_message(message));
        }

        #[cfg(target_os = "windows")]
        if !matches!(*self.get_running_mode(), RunningMode::NotRunning) {
            self.prepare_windows_tun_network().await?;
        }

        self.apply_generate_config_inner().await
    }

    pub(crate) async fn update_runtime_config<F>(&self, f: F) -> Result<ValidationOutcome>
    where
        F: FnOnce(&mut IRuntime),
    {
        if !self.try_start_config_update() {
            logging!(info, Type::Core, "Configuration update is already running");
            return Ok(ValidationOutcome::Busy);
        }
        defer! {
            self.finish_config_update();
        }

        Config::runtime().await.edit_draft(f);
        self.apply_generate_config_inner().await
    }

    async fn apply_generate_config_inner(&self) -> Result<ValidationOutcome> {
        match CoreConfigValidator::global().validate_config_outcome().await {
            Ok(outcome) if outcome.is_valid() => {
                let run_path = Config::generate_file(ConfigType::Run).await?;
                self.apply_config(run_path).await?;
                Ok(ValidationOutcome::Valid)
            }
            Ok(outcome) => {
                Config::runtime().await.discard();
                Ok(outcome)
            }
            Err(e) => {
                Config::runtime().await.discard();
                Err(e)
            }
        }
    }

    #[cfg(target_os = "windows")]
    async fn prepare_windows_tun_network(&self) -> Result<bool> {
        use crate::utils::windows_network::{
            apply_managed_upstream, detect_stable_upstream, tun_needs_managed_upstream,
        };

        let runtime = Config::runtime().await;
        let runtime_latest = runtime.latest_arc();
        let Some(mut config) = runtime_latest.config.clone() else {
            return Ok(false);
        };
        let source_has_interface = runtime_latest.exists_keys.contains("interface-name");
        drop(runtime_latest);

        let app_has_interface = Config::clash()
            .await
            .latest_arc()
            .0
            .get("interface-name")
            .and_then(serde_yaml_ng::Value::as_str)
            .is_some_and(|value| !value.trim().is_empty());
        let has_explicit_interface = source_has_interface || app_has_interface;

        if !tun_needs_managed_upstream(&config, has_explicit_interface) {
            return Ok(false);
        }

        logging!(
            info,
            Type::Core,
            "Windows TUN safety: waiting for a stable physical default route before starting or reloading TUN"
        );

        let route = tokio::task::spawn_blocking(detect_stable_upstream)
            .await
            .map_err(|error| anyhow!("Windows TUN route inspection task failed: {error}"))??;

        apply_managed_upstream(&mut config, &route);
        runtime.edit_draft(|draft| {
            draft.config = Some(config);
        });

        logging!(
            info,
            Type::Core,
            "Windows TUN safety: pinned outbound interface={} index={} source={} gateway={} metric={} (auto-detect-interface=false)",
            route.interface_alias,
            route.interface_index,
            route.source_address,
            route.gateway,
            route.effective_metric
        );
        Ok(true)
    }

    #[cfg(target_os = "windows")]
    pub(super) async fn prepare_windows_tun_runtime_for_start(&self) -> Result<()> {
        if !self.prepare_windows_tun_network().await? {
            return Ok(());
        }

        let outcome = CoreConfigValidator::global().validate_config_outcome().await?;
        if !outcome.is_valid() {
            Config::runtime().await.discard();
            return Err(anyhow!(
                "Windows TUN safety configuration did not pass validation: {outcome}"
            ));
        }

        Config::generate_file(ConfigType::Run).await?;
        Config::runtime().await.apply();
        logging!(
            info,
            Type::Core,
            "Windows TUN safety: stable upstream stored in runtime configuration"
        );
        Ok(())
    }

    async fn apply_config(&self, path: PathBuf) -> Result<()> {
        if matches!(*self.get_running_mode(), RunningMode::NotRunning) {
            Config::runtime().await.apply();
            logging!(
                info,
                Type::Core,
                "core is stopped; staged configuration without starting it"
            );
            return Ok(());
        }

        let path = dirs::path_to_str(&path)?;
        match self.reload_config(path).await {
            Ok(_) => {
                Config::runtime().await.apply();
                logging!(info, Type::Core, "Configuration applied");
                Ok(())
            }
            Err(err) => {
                logging!(
                    warn,
                    Type::Core,
                    "Failed to apply configuration by mihomo api, restart core to apply it, error msg: {err}"
                );
                match self.restart_core().await {
                    Ok(_) => {
                        Config::runtime().await.apply();
                        logging!(info, Type::Core, "Configuration applied after restart");
                        Ok(())
                    }
                    Err(err) => {
                        logging!(error, Type::Core, "Failed to restart core: {}", err);
                        Config::runtime().await.discard();
                        Err(anyhow!("Failed to apply config: {}", err))
                    }
                }
            }
        }
    }

    async fn reload_config(&self, path: &str) -> Result<(), MihomoError> {
        handle::Handle::mihomo().await.reload_config(true, path).await
    }
}
