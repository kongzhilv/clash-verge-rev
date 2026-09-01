from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_between(text: str, start: str, end: str, replacement: str) -> str:
    i = text.index(start)
    j = text.index(end, i)
    return text[:i] + replacement.rstrip() + "\n\n" + text[j:]


rust_path = "src-tauri/src/core/windows_hotspot_ics.rs"
rust = read(rust_path)

role_mutation_block = '''fn role_mutation(current: Option<SharingRole>, desired: Option<SharingRole>) -> RoleMutation {
    match (current, desired) {
        (current, desired) if current == desired => RoleMutation::None,
        (_, Some(role)) => RoleMutation::Enable(role),
        (Some(_), None) => RoleMutation::Disable,
        (None, None) => RoleMutation::None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeaseApplyOrder {
    TunPublicOnly,
    HotspotPrivateThenTunPublic,
}

impl LeaseApplyOrder {
    fn label(self) -> &'static str {
        match self {
            Self::TunPublicOnly => "tun-public-only-existing-hotspot-private",
            Self::HotspotPrivateThenTunPublic => "hotspot-private-then-tun-public",
        }
    }
}

fn lease_apply_order(original: &[SavedRole], pair: &TargetPair) -> LeaseApplyOrder {
    if role_of_guid(original, pair.hotspot.guid) == Some(SharingRole::Private) {
        LeaseApplyOrder::TunPublicOnly
    } else {
        LeaseApplyOrder::HotspotPrivateThenTunPublic
    }
}

fn sharing_role_name(role: SharingRole) -> &'static str {
    match role {
        SharingRole::Public => "public",
        SharingRole::Private => "private",
    }
}

fn hresult_symbol(raw: i32) -> &'static str {
    match raw as u32 {
        0x80004004 => "E_ABORT",
        0x80004005 => "E_FAIL",
        0x80070057 => "E_INVALIDARG",
        0x80004002 => "E_NOINTERFACE",
        0x80004001 => "E_NOTIMPL",
        0x8007000E => "E_OUTOFMEMORY",
        0x80004003 => "E_POINTER",
        _ => "UNKNOWN_HRESULT",
    }
}

fn error_chain_strings(error: &anyhow::Error) -> Vec<String> {
    error.chain().map(|item| item.to_string()).collect()
}'''
rust = replace_between(rust, "fn role_mutation(", "fn snapshot_path()", role_mutation_block)

reconcile_block = '''fn reconcile_connection_role(
    manager: &INetSharingManager,
    connection: &INetConnection,
    desired: Option<SharingRole>,
    context: &'static str,
) -> Result<bool> {
    let state = connection_log(manager, connection)?;
    let mutation = role_mutation(state.sharing_role, desired);
    let configuration = sharing_configuration(manager, connection)?;
    let desired_name = desired.map(sharing_role_name).unwrap_or("disabled");
    let current_name = state.sharing_role.map(sharing_role_name).unwrap_or("disabled");

    match mutation {
        RoleMutation::None => Ok(false),
        RoleMutation::Enable(role) => {
            set_role(&configuration, role).with_context(|| {
                format!(
                    "{context}; adapter_name={}; device_name={}; guid={}; current_role={current_name}; desired_role={desired_name}",
                    state.name, state.device_name, state.guid
                )
            })?;
            Ok(true)
        }
        RoleMutation::Disable => {
            unsafe { configuration.DisableSharing() }.with_context(|| {
                format!(
                    "{context}; adapter_name={}; device_name={}; guid={}; current_role={current_name}; desired_role={desired_name}",
                    state.name, state.device_name, state.guid
                )
            })?;
            Ok(true)
        }
    }
}'''
rust = replace_between(rust, "fn reconcile_connection_role(", "fn find_connection(", reconcile_block)

set_role_block = '''fn set_role(configuration: &INetSharingConfiguration, role: SharingRole) -> Result<()> {
    let result = unsafe {
        match role {
            SharingRole::Public => configuration.EnableSharing(ICSSHARINGTYPE_PUBLIC),
            SharingRole::Private => configuration.EnableSharing(ICSSHARINGTYPE_PRIVATE),
        }
    };

    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            let raw = error.code().0;
            bail!(
                "INetSharingConfiguration::EnableSharing failed; role={}; hresult=0x{:08X}; hresult_i32={}; symbol={}; windows_error={}",
                sharing_role_name(role),
                raw as u32,
                raw,
                hresult_symbol(raw),
                error
            )
        }
    }
}'''
rust = replace_between(rust, "fn set_role(", "fn create_managers()", set_role_block)

apply_block = '''fn apply_pair_unlocked(path: &Path, pair: &TargetPair) -> Result<()> {
    let (_apartment, sharing_manager, connection_manager) = create_managers()?;
    let connections = enumerate_connections(&connection_manager)?;
    log_all_sharing_state(&sharing_manager, &connections, "apply-before");

    let original = current_shared_roles(&sharing_manager, &connections)?;
    if has_unrelated_private_role(&original, pair) {
        diagnostics::warn(
            "windows-hotspot-ics",
            "lease-refused-unrelated-private-sharing",
            json!({
                "originally_shared": &original,
                "action": "fail-closed-preserve-unrelated-private-ics",
            }),
        );
        bail!("refusing to replace an unrelated existing PRIVATE ICS connection");
    }

    let tun = find_connection(&sharing_manager, &connections, pair.tun.guid)?
        .ok_or_else(|| anyhow!("Mihomo TUN connection disappeared before ICS apply"))?;
    let hotspot = find_connection(&sharing_manager, &connections, pair.hotspot.guid)?
        .ok_or_else(|| anyhow!("Mobile Hotspot connection disappeared before ICS apply"))?;

    let apply_order = lease_apply_order(&original, pair);
    diagnostics::info(
        "windows-hotspot-ics",
        "apply-plan",
        json!({
            "order": apply_order.label(),
            "hotspot_role_before": role_of_guid(&original, pair.hotspot.guid).map(sharing_role_name),
            "tun_role_before": role_of_guid(&original, pair.tun.guid).map(sharing_role_name),
            "private_settle_ms": 500,
            "public_settle_ms": 250,
            "reason": "prepare-private-side-before-public-when-hnetcfg-does-not-expose-existing-mobile-hotspot-private-role",
        }),
    );

    let snapshot = SavedSharingState {
        version: 2,
        created_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        tun_guid: guid_string(pair.tun.guid),
        hotspot_guid: guid_string(pair.hotspot.guid),
        originally_shared: lease_owned_original_roles(&original, pair),
    };
    save_snapshot(path, &snapshot)?;

    let apply_result = (|| -> Result<(bool, bool)> {
        let hotspot_changed = match apply_order {
            LeaseApplyOrder::TunPublicOnly => false,
            LeaseApplyOrder::HotspotPrivateThenTunPublic => {
                let changed = reconcile_connection_role(
                    &sharing_manager,
                    &hotspot,
                    Some(SharingRole::Private),
                    "apply Mobile Hotspot PRIVATE ICS role before PUBLIC",
                )?;
                if changed {
                    std::thread::sleep(Duration::from_millis(500));
                }
                changed
            }
        };

        let tun_changed = reconcile_connection_role(
            &sharing_manager,
            &tun,
            Some(SharingRole::Public),
            "apply Mihomo TUN PUBLIC ICS role after PRIVATE preparation",
        )?;
        if tun_changed {
            std::thread::sleep(Duration::from_millis(250));
        }

        let after = current_shared_roles(&sharing_manager, &connections)?;
        if !lease_roles_are_desired(&after, pair) {
            bail!("ICS role verification failed after state-aware minimal-diff apply");
        }
        Ok((tun_changed, hotspot_changed))
    })();

    let (tun_changed, hotspot_changed) = match apply_result {
        Ok(changed) => changed,
        Err(error) => {
            diagnostics::error(
                "windows-hotspot-ics",
                "apply-verification-failed",
                json!({
                    "error": error.to_string(),
                    "error_full": format!("{error:#}"),
                    "error_chain": error_chain_strings(&error),
                    "apply_order": apply_order.label(),
                    "tun_guid": guid_string(pair.tun.guid),
                    "hotspot_guid": guid_string(pair.hotspot.guid),
                    "action": "restore-original-ics-immediately",
                }),
            );
            restore_snapshot_unlocked(path, &snapshot).context("apply failed and rollback also failed")?;
            return Err(error);
        }
    };

    log_all_sharing_state(&sharing_manager, &connections, "apply-after");
    diagnostics::info(
        "windows-hotspot-ics",
        "lease-applied",
        json!({
            "tun": {
                "guid": guid_string(pair.tun.guid),
                "alias": pair.tun.alias,
                "description": pair.tun.description,
                "role": "public",
                "mutated": tun_changed,
            },
            "hotspot": {
                "guid": guid_string(pair.hotspot.guid),
                "alias": pair.hotspot.alias,
                "description": pair.hotspot.description,
                "role": "private",
                "mutated": hotspot_changed,
            },
            "apply_order": apply_order.label(),
            "originally_shared": original,
            "snapshot_file_present": true,
            "rollback_scope": "minimal-diff-original-public+lease-targets-only",
            "strategy": "mihomo-tun-as-ics-public-with-minimal-diff-persistent-rollback",
        }),
    );
    Ok(())
}'''
rust = replace_between(rust, "fn apply_pair_unlocked(", "fn mutation_guard()", apply_block)

old_monitor_error = '''                if message != last_error {
                    diagnostics::error(
                        "windows-hotspot-ics",
                        "reconcile-failed",
                        json!({
                            "error": message,
                            "stable_signature": current_signature,
                            "snapshot_file_present": path.exists(),
                            "action": "fail-closed-or-rollback",
                        }),
                    );
                    last_error = message;
                }'''
new_monitor_error = '''                if message != last_error {
                    diagnostics::error(
                        "windows-hotspot-ics",
                        "reconcile-failed",
                        json!({
                            "error": message,
                            "error_full": format!("{error:#}"),
                            "error_chain": error_chain_strings(&error),
                            "stable_signature": current_signature,
                            "snapshot_file_present": path.exists(),
                            "action": "fail-closed-or-rollback",
                        }),
                    );
                    last_error = message;
                }'''
if old_monitor_error not in rust:
    raise SystemExit("monitor error block not found")
rust = rust.replace(old_monitor_error, new_monitor_error, 1)

extra_tests = r'''

    #[test]
    fn windows_network_unshared_hotspot_prepares_private_before_public() {
        let pair = pair();
        let original = Vec::<SavedRole>::new();
        assert_eq!(
            super::lease_apply_order(&original, &pair),
            super::LeaseApplyOrder::HotspotPrivateThenTunPublic
        );
        assert_eq!(
            super::LeaseApplyOrder::HotspotPrivateThenTunPublic.label(),
            "hotspot-private-then-tun-public"
        );
    }

    #[test]
    fn windows_network_existing_hotspot_private_skips_private_mutation() {
        let pair = pair();
        let original = vec![SavedRole {
            guid: format!("{:?}", pair.hotspot.guid),
            role: SharingRole::Private,
        }];
        assert_eq!(
            super::lease_apply_order(&original, &pair),
            super::LeaseApplyOrder::TunPublicOnly
        );
    }

    #[test]
    fn windows_network_hresult_symbols_cover_enable_sharing_failures() {
        assert_eq!(super::hresult_symbol(0x80004002u32 as i32), "E_NOINTERFACE");
        assert_eq!(super::hresult_symbol(0x80004005u32 as i32), "E_FAIL");
        assert_eq!(super::hresult_symbol(0x80070057u32 as i32), "E_INVALIDARG");
    }
'''
head, tail = rust.rsplit("\n}", 1)
rust = head + extra_tests + "\n}" + tail
write(rust_path, rust)

# Create an explicit v25 hotspot safety gate/workflow while keeping v24 immutable.
v24_gate = read("scripts/check-windows-hotspot-zero-owner-v24.mjs")
v25_gate = v24_gate.replace("v24", "v25")
v25_gate = v25_gate.replace(
    "await import('./check-windows-hotspot-zero-owner-v25.mjs')",
    "await import('./check-windows-hotspot-zero-owner-v24.mjs')",
)
v25_gate = v25_gate.replace(
    "  'reconcile_connection_role',\n",
    "  'reconcile_connection_role',\n  'LeaseApplyOrder',\n  'hotspot-private-then-tun-public',\n  'hresult=0x',\n  'error_chain',\n",
    1,
)
v25_gate = v25_gate.replace(
    "  'windows_network_saved_role_lookup_is_guid_normalized',\n",
    "  'windows_network_saved_role_lookup_is_guid_normalized',\n  'windows_network_unshared_hotspot_prepares_private_before_public',\n  'windows_network_existing_hotspot_private_skips_private_mutation',\n  'windows_network_hresult_symbols_cover_enable_sharing_failures',\n",
    1,
)
write("scripts/check-windows-hotspot-zero-owner-v25.mjs", v25_gate)

v24_workflow = read(".github/workflows/karing-windows-hotspot-v24.yml")
v25_workflow = v24_workflow.replace("v24", "v25")
needle = '''      - name: Prove unchanged hotspot PRIVATE role is never bounced
        working-directory: src-tauri
        run: cargo test --target x86_64-pc-windows-msvc --lib windows_network_minimal_diff_preserves_existing_hotspot_private_role --all-features -- --exact --nocapture
'''
addition = needle + '''      - name: Prove unshared hotspot is prepared PRIVATE before PUBLIC
        working-directory: src-tauri
        run: cargo test --target x86_64-pc-windows-msvc --lib windows_network_unshared_hotspot_prepares_private_before_public --all-features -- --exact --nocapture
      - name: Prove EnableSharing HRESULT diagnostics are preserved
        working-directory: src-tauri
        run: cargo test --target x86_64-pc-windows-msvc --lib windows_network_hresult_symbols_cover_enable_sharing_failures --all-features -- --exact --nocapture
'''
if needle not in v25_workflow:
    raise SystemExit("v25 workflow insertion point not found")
v25_workflow = v25_workflow.replace(needle, addition, 1)
write(".github/workflows/karing-windows-hotspot-v25.yml", v25_workflow)

# Main release gate + metadata now targets the corrective .25 release.
diag_path = ".github/workflows/karing-diagnostics-once.yml"
diag = read(diag_path)
diag = diag.replace(
    "运行 Windows Mobile Hotspot v24 生命周期/数据面安全回归",
    "运行 Windows Mobile Hotspot v25 生命周期/数据面安全回归",
)
diag = diag.replace(
    "node scripts/check-windows-hotspot-zero-owner-v24.mjs",
    "node scripts/check-windows-hotspot-zero-owner-v25.mjs",
    1,
)
gate_anchor = "          check_contains src-tauri/src/core/windows_hotspot_ics.rs 'mihomo-tun-as-ics-public-with-minimal-diff-persistent-rollback' '热点 VPN 数据面使用持久最小差异 ICS lease'\n"
gate_extra = gate_anchor + "          check_contains src-tauri/src/core/windows_hotspot_ics.rs 'hotspot-private-then-tun-public' '未暴露 PRIVATE 角色时先准备热点 PRIVATE 再切 Mihomo PUBLIC'\n          check_contains src-tauri/src/core/windows_hotspot_ics.rs 'hresult=0x' 'EnableSharing 失败记录 HRESULT'\n          check_contains src-tauri/src/core/windows_hotspot_ics.rs 'error_chain' 'ICS 失败保留完整错误链'\n"
if gate_anchor not in diag:
    raise SystemExit("main gate anchor not found")
diag = diag.replace(gate_anchor, gate_extra, 1)
build_info_anchor = "          Windows Mobile Hotspot VPN data plane: native HNetCfg ICS minimal-diff lease; Mihomo TUN=PUBLIC, hotspot=PRIVATE\n"
build_info_extra = build_info_anchor + "          Windows Mobile Hotspot ICS apply order: preserve existing PRIVATE; otherwise hotspot PRIVATE before Mihomo PUBLIC\n          Windows Mobile Hotspot ICS diagnostics: EnableSharing HRESULT/symbol + full error chain retained\n"
if build_info_anchor not in diag:
    raise SystemExit("BUILD_INFO anchor not found")
diag = diag.replace(build_info_anchor, build_info_extra, 1)
diag = diag.replace("v2.5.4-karing.24", "v2.5.4-karing.25")
diag = diag.replace(
    "- 热点客户端仍需进入 VPN，因此保留并收敛到原生 HNetCfg COM 数据面：动态识别当前 Mihomo TUN 与活动 Wi-Fi Direct 热点侧，将 `Mihomo TUN=ICS PUBLIC`、`Mobile Hotspot=ICS PRIVATE`，不依赖本地化网卡名，也不写死 `192.168.137.0/24`。",
    "- 热点客户端仍需进入 VPN，因此保留并收敛到原生 HNetCfg COM 数据面：动态识别当前 Mihomo TUN 与活动 Wi-Fi Direct 热点侧，将 `Mihomo TUN=ICS PUBLIC`、`Mobile Hotspot=ICS PRIVATE`，不依赖本地化网卡名，也不写死 `192.168.137.0/24`。\n          - `.25` 修复真实 Windows 现场暴露的应用顺序问题：HNetCfg 未显示热点 PRIVATE 时先建立 PRIVATE，等待 ICS 稳定后再建立 Mihomo PUBLIC；热点原本已是 PRIVATE 时保持零 mutation。EnableSharing 失败同时记录 HRESULT、符号名和完整错误链。",
)
diag = diag.replace("与 `.24` 专项全部对应同一发行 SHA", "与 `.25` 专项全部对应同一发行 SHA")
diag = diag.replace("`.24` 热点生命周期/ICS 数据面策略", "`.25` 热点生命周期/ICS 数据面策略")
write(diag_path, diag)

observer_path = ".github/workflows/karing-release-observer.yml"
observer = read(observer_path)
observer = observer.replace("name: Karing .24 发行核验", "name: Karing .25 发行核验")
observer = observer.replace("核验 v2.5.4-karing.24 正式发行", "核验 v2.5.4-karing.25 正式发行")
observer = observer.replace("v2.5.4-karing.24", "v2.5.4-karing.25")
observer = observer.replace("karing-windows-hotspot-v24.yml", "karing-windows-hotspot-v25.yml")
observer = observer.replace("karing-v254-karing24-release-audit", "karing-v254-karing25-release-audit")
observer = observer.replace("PR_NUMBER: '17'", "PR_NUMBER: '1'")
observer = observer.replace("Compile v24 network path", "Compile v25 network path")
observer = observer.replace("Run v24 lifecycle + ICS + topology regressions", "Run v25 lifecycle + ICS + topology regressions")
observer = observer.replace("Hotspot v24 lifecycle/data-plane run", "Hotspot v25 lifecycle/data-plane run")
verify_anchor = "          grep -Fqx 'Windows Mobile Hotspot VPN data plane: native HNetCfg ICS minimal-diff lease; Mihomo TUN=PUBLIC, hotspot=PRIVATE' release-audit/BUILD_INFO.txt\n"
verify_extra = verify_anchor + "          grep -Fqx 'Windows Mobile Hotspot ICS apply order: preserve existing PRIVATE; otherwise hotspot PRIVATE before Mihomo PUBLIC' release-audit/BUILD_INFO.txt\n          grep -Fqx 'Windows Mobile Hotspot ICS diagnostics: EnableSharing HRESULT/symbol + full error chain retained' release-audit/BUILD_INFO.txt\n"
if verify_anchor not in observer:
    raise SystemExit("observer BUILD_INFO anchor not found")
observer = observer.replace(verify_anchor, verify_extra, 1)
write(observer_path, observer)

write(".release/karing-release-tag.txt", "v2.5.4-karing.25\n")

# Remove the one-shot repair machinery from the resulting release commit.
(ROOT / ".github/workflows/karing-hotspot-v25-repair.yml").unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)

print("Karing hotspot v25 repair staged")
