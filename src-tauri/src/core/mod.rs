pub mod autostart;
pub mod backup;
pub mod diagnostics;
pub mod handle;
pub mod hotkey;
pub mod logger;
pub mod manager;
mod notification;
pub mod outbound_diagnostics;
pub mod service;
pub mod sysopt;
pub mod timer;
pub mod tray;
pub mod updater;
pub mod validate;
pub mod win_uwp;
#[cfg(target_os = "windows")]
pub mod windows_network_diagnostics;

pub use self::{manager::CoreManager, timer::Timer, updater::SilentUpdater};
