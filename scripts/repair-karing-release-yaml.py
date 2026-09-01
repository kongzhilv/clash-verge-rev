from pathlib import Path

OPEN = "$" + "{{"
CLOSE = "}}"


def expr(body: str) -> str:
    return OPEN + " " + body + " " + CLOSE


main_path = Path(".github/workflows/karing-diagnostics-once.yml")
main = main_path.read_text(encoding="utf-8")

lines = main.splitlines()
if len(lines) < 2 or not lines[1].startswith("run-name:"):
    raise SystemExit("unexpected main run-name layout")
lines[1] = "run-name: " + expr(
    "github.event_name == 'pull_request' && '审查 Karing 桌面版安装包' || "
    "(github.event_name == 'push' && startsWith(github.event.head_commit.message, 'release(karing)') "
    "&& '构建并发布 Karing 桌面版' || '审查并构建 Karing 桌面版候选')"
)
main = "\n".join(lines) + "\n"

old_scope = (
    "          check_contains src-tauri/src/core/windows_hotspot_ics_v27.rs "
    "'NetworkInformation::GetInternetConnectionProfile' "
    "'v27 动态捕获当前 Internet 上游 GUID'"
)
new_scope = "\n".join(
    [
        "          check_contains src-tauri/src/core/windows_hotspot_ics_v27.rs 'detect_stable_upstream' 'v27 复用 native 稳定物理默认路由探测'",
        "          check_contains src-tauri/src/core/windows_hotspot_ics_v27.rs 'row.InterfaceIndex == upstream.interface_index' 'v27 将稳定物理接口 index 映射到当前 Windows 接口'",
        "          check_contains src-tauri/src/core/windows_hotspot_ics_v27.rs 'guid_string(row.InterfaceGuid)' 'v27 从 native 接口表解析当前物理上游 GUID'",
        "          check_contains src-tauri/src/core/windows_hotspot_ics_v27.rs 'require_dynamic_restore_anchor' 'v27 ICS 获取与恢复要求动态物理路由锚点'",
        "          check_contains src-tauri/src/core/windows_hotspot_ics_v27.rs 'no stable physical IPv4 default route is available' 'v27 缺少稳定物理路由锚点时 fail-closed'",
        "          check_contains src-tauri/src/core/windows_hotspot_ics_v27.rs 'v27_dynamic_restore_anchor_fails_closed_when_physical_route_is_unavailable' 'v27 缺少动态物理锚点具有单元回归'",
        "          check_not_contains src-tauri/src/core/windows_hotspot_ics_v27.rs 'NetworkInformation::GetInternetConnectionProfile' 'v27 不再依赖 WinRT Internet profile 作为物理上游来源'",
        "          check_not_contains src-tauri/src/core/windows_hotspot_ics_v27.rs 'select_restore_upstream_guid' 'v27 不再回退到持久快照选择过期物理上游'",
    ]
)
if old_scope not in main:
    raise SystemExit("stale WinRT release-scope assertion not found")
main = main.replace(old_scope, new_scope, 1)

marker = "\n    authorize_release:\n"
start_marker = main.find(marker)
if start_marker < 0:
    raise SystemExit("malformed authorize_release block not found")
start = start_marker + 1
end = main.find("\n  publish-release:\n", start)
if end < 0:
    raise SystemExit("publish-release marker not found")

block_lines = [
    "  authorize_release:",
    "    name: 校验正式发行授权",
    "    needs:",
    "      - review",
    "      - package-release",
    "    runs-on: ubuntu-latest",
    "    outputs:",
    "      authorized: " + expr("steps.gate.outputs.authorized"),
    "    steps:",
    "      - name: 检出发行授权提交",
    "        uses: actions/checkout@v7",
    "        with:",
    "          fetch-depth: 2",
    "",
    "      - name: Fail-closed 校验发行授权",
    "        id: gate",
    "        env:",
    "          RELEASE_TAG: " + expr("needs.review.outputs.release_tag"),
    "          COMMIT_MESSAGE: " + expr("github.event.head_commit.message"),
    "        shell: bash",
    "        run: |",
    "          set -euo pipefail",
    "          echo 'authorized=false' >> \"$GITHUB_OUTPUT\"",
    "",
    "          if [ \"$GITHUB_EVENT_NAME\" != 'push' ]; then",
    "            echo '非 push 事件：仅构建候选，不发布'",
    "            exit 0",
    "          fi",
    "          if [ \"$GITHUB_REF\" != 'refs/heads/feature/karing-style-diversion' ]; then",
    "            echo '非发行分支：仅构建候选，不发布'",
    "            exit 0",
    "          fi",
    "          if [ \"$GITHUB_ACTOR\" != 'kongzhilv' ]; then",
    "            echo \"非仓库发行账户触发：${GITHUB_ACTOR}\"",
    "            exit 0",
    "          fi",
    "          if [[ \"$COMMIT_MESSAGE\" != \"release(karing): publish ${RELEASE_TAG}\" ]]; then",
    "            echo 'commit message 未形成精确发行授权'",
    "            exit 0",
    "          fi",
    "",
    "          mapfile -t changed < <(git diff-tree --no-commit-id --name-only -r \"$GITHUB_SHA\")",
    "          if [ \"${#changed[@]}\" -ne 1 ] || [ \"${changed[0]}\" != '.release/karing-release-authorize.txt' ]; then",
    "            echo '发行授权提交必须且只能修改 .release/karing-release-authorize.txt'",
    "            for path in \"${changed[@]}\"; do",
    "              printf 'changed: %s\\n' \"$path\"",
    "            done",
    "            exit 0",
    "          fi",
    "",
    "          test -f .release/karing-release-authorize.txt || { echo '缺少发行授权文件'; exit 0; }",
    r"          authorization=$(tr -d '\r\n' < .release/karing-release-authorize.txt)",
    "          if [ \"$authorization\" != \"PUBLISH:${RELEASE_TAG}\" ]; then",
    "            echo '发行授权内容与当前 tag 不匹配'",
    "            exit 0",
    "          fi",
    "",
    "          echo 'authorized=true' >> \"$GITHUB_OUTPUT\"",
    "          echo \"正式发行授权通过：${RELEASE_TAG} @ ${GITHUB_SHA}\"",
]
block = "\n".join(block_lines) + "\n"
main = main[:start] + block + main[end + 1 :]
main_path.write_text(main, encoding="utf-8")

observer_path = Path(".github/workflows/karing-release-observer.yml")
observer = observer_path.read_text(encoding="utf-8")
observer = observer.replace("      - '.github/workflows/karing-release-observer.yml'\n", "", 1)
bad_if = "    if: " + expr(
    "startsWith(github.event.head_commit.message, 'release(karing): publish ')"
) + "\n"
if bad_if not in observer:
    raise SystemExit("observer release if marker not found")
observer = observer.replace(bad_if, "", 1)
observer_path.write_text(observer, encoding="utf-8")

print("repaired release workflow YAML files")
