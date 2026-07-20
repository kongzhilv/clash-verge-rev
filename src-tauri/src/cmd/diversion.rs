use super::{CmdResult, StringifyErr as _};
use crate::{
    cmd::{profile::read_profile_file, save_profile::save_profile_file},
    core::validate::ValidationOutcome,
    utils::yaml_emitter,
};
use serde_yaml_ng::{Mapping, Value};
use smartstring::alias::String;

const CONFIG_KEY: &str = "x-karing-diversion";

fn parse_merge(content: &str) -> CmdResult<Mapping> {
    if content.trim().is_empty() {
        return Ok(Mapping::new());
    }

    serde_yaml_ng::from_str::<Mapping>(content).stringify_err()
}

#[tauri::command]
pub async fn get_diversion_config() -> CmdResult<Value> {
    let content = read_profile_file("Merge".into()).await?;
    let merge = parse_merge(&content)?;

    Ok(merge
        .get(CONFIG_KEY)
        .cloned()
        .unwrap_or_else(|| Value::Mapping(Mapping::new())))
}

#[tauri::command]
pub async fn save_diversion_config(config: Value) -> CmdResult<ValidationOutcome> {
    if !config.is_mapping() {
        return Err(String::from("diversion config must be a mapping"));
    }

    let content = read_profile_file("Merge".into()).await?;
    let mut merge = parse_merge(&content)?;
    merge.insert(Value::from(CONFIG_KEY), config);

    let yaml = yaml_emitter::to_mihomo_config_string(&merge).stringify_err()?;
    save_profile_file("Merge".into(), Some(yaml.into())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_merge_is_supported() {
        assert!(parse_merge("").expect("empty merge should parse").is_empty());
    }

    #[test]
    fn existing_merge_keys_are_preserved() {
        let mut merge = parse_merge("dns:\n  enable: true\n").expect("merge should parse");
        merge.insert(Value::from(CONFIG_KEY), Value::Mapping(Mapping::new()));
        assert!(merge.contains_key("dns"));
        assert!(merge.contains_key(CONFIG_KEY));
    }
}
