from pathlib import Path

path = Path('.github/workflows/karing-diagnostics-once.yml')
text = path.read_text(encoding='utf-8')


def one(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    text = text.replace(old, new, 1)

# Make release staging itself part of the permanent review/release trigger.
needle = "      - '.cargo/**'\n"
if text.count(needle) != 2:
    raise SystemExit(f'release trigger anchors: expected 2, found {text.count(needle)}')
text = text.replace(needle, needle + "      - '.release/**'\n")

one('  RELEASE_TAG: v2.5.4-karing.11\n', '', 'remove stale release tag')

one(
    "    outputs:\n      version: ${{ steps.meta.outputs.version }}\n      commit: ${{ steps.meta.outputs.commit }}\n",
    "    outputs:\n      version: ${{ steps.meta.outputs.version }}\n      commit: ${{ steps.meta.outputs.commit }}\n      release_tag: ${{ steps.meta.outputs.release_tag }}\n",
    'review output release tag',
)

one(
    "          version=$(jq -r .version package.json)\n          commit=$(git rev-parse HEAD)\n          test \"$version\" = '2.5.4'\n",
    "          version=$(jq -r .version package.json)\n          commit=$(git rev-parse HEAD)\n          release_tag=$(tr -d '\\r\\n' < .release/karing-release-tag.txt)\n          test \"$version\" = '2.5.4'\n          if [[ ! \"$release_tag\" =~ ^v${version}-karing\\.[0-9]+$ ]]; then\n            echo \"非法 Karing Release tag: $release_tag\" >&2\n            exit 1\n          fi\n",
    'read staged release tag',
)

one(
    "          echo \"version=$version\" >> \"$GITHUB_OUTPUT\"\n          echo \"commit=$commit\" >> \"$GITHUB_OUTPUT\"\n",
    "          echo \"version=$version\" >> \"$GITHUB_OUTPUT\"\n          echo \"commit=$commit\" >> \"$GITHUB_OUTPUT\"\n          echo \"release_tag=$release_tag\" >> \"$GITHUB_OUTPUT\"\n",
    'export staged release tag',
)

scope_anchor = "          check_contains src-tauri/src/cmd/clash.rs 'pub async fn start_proxy()' '后端已实现启动主代理命令'\n"
if scope_anchor not in text:
    raise SystemExit('release scope anchor missing')
text = text.replace(
    scope_anchor,
    "          check_contains src-tauri/src/feat/clash.rs 'MIHOMO_CONTROL_MAX_ATTEMPTS' 'Mihomo 控制 API 启动就绪采用有界重试'\n"
    "          check_contains src-tauri/src/feat/clash.rs 'control-read-retry' '控制 API 瞬态失败记录重试诊断'\n"
    "          check_contains src-tauri/src/feat/clash.rs 'control-read-recovered' '控制 API 恢复后记录就绪耗时'\n"
    "          check_contains src-tauri/src/cmd/clash.rs 'ui-get-clash-mode' 'UI mode 读取复用控制 API 就绪逻辑'\n"
    "          check_contains src-tauri/src/cmd/clash.rs '\"start-requested\"' '核心启动生命周期进入结构化诊断'\n"
    + scope_anchor,
    1,
)

one(
    '          Release tag: ${RELEASE_TAG}\n',
    '          Release tag: ${{ needs.review.outputs.release_tag }}\n',
    'build info release tag',
)

notes_anchor = "          - Windows TUN/热点安全、程序归因、UI 成熟度与诊断日志均纳入发行门禁。\n"
if notes_anchor not in text:
    raise SystemExit('release notes anchor missing')
text = text.replace(
    notes_anchor,
    notes_anchor
    + "          - Mihomo 控制 API 在 Core 启动后采用短窗口有界 readiness 重试，修复 named-pipe 已建立但 `/configs` 尚不可稳定解码时的首次 mode readback 竞态；仅记录控制面重试/恢复，不重复采集逐连接流量日志。\n"
    + "          - Release tag 改为 `.release/karing-release-tag.txt` 显式 staging，正式流水线不再硬编码历史标签。\n",
    1,
)

publish_anchor = "    permissions:\n      contents: write\n    steps:\n"
if publish_anchor not in text:
    raise SystemExit('publish env anchor missing')
text = text.replace(
    publish_anchor,
    "    permissions:\n      contents: write\n    env:\n      RELEASE_TAG: ${{ needs.review.outputs.release_tag }}\n    steps:\n",
    1,
)

one(
    '--title "Clash Verge Rev Karing v${{ needs.review.outputs.version }} · Network Diagnostics + TUN Safety" \\\n',
    '--title "Clash Verge Rev Karing v${{ needs.review.outputs.version }} · Control Readiness + Mode Consistency" \\\n',
    'release title',
)

path.write_text(text, encoding='utf-8')
print('patched permanent staged release pipeline')
