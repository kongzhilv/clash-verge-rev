use anyhow::Result;
use smartstring::alias::String;

pub type CmdResult<T = ()> = Result<T, String>;

// Command modules
pub mod app;
pub mod backup;
pub mod clash;
pub mod lightweight;
pub mod media_unlock_checker;
pub mod network;
pub mod profile;
pub mod proxy;
pub mod runtime;
pub mod save_profile;
pub mod service;
pub mod system;
pub mod uwp;
pub mod validate;
pub mod verge;
pub mod webdav;
