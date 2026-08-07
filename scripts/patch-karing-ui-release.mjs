import { readFile, writeFile } from 'node:fs/promises'

const workflowPath = '.github/workflows/karing-diagnostics-once.yml'
let text = await readFile(workflowPath, 'utf8')

const replaceOnce = (oldText, newText, label) => {
  const first = text.indexOf(oldText)
  const second = first < 0 ? -1 : text.indexOf(oldText, first + oldText.length)
  if (first < 0 || second >= 0) {
    throw new Error(`${label}: expected exactly one match`)
  }
  text = `${text.slice(0, first)}${newText}${text.slice(first + oldText.length)}`
}

replaceOnce(
  '  RELEASE_TAG: v2.5.4-karing.6',
  '  RELEASE_TAG: v2.5.4-karing.7',
  'release tag',
)

replaceOnce(
  `      - name: 运行程序归因专项回归
        run: node scripts/check-karing-process-attribution.mjs

      - name: 运行 Rust Clippy`,
  `      - name: 运行程序归因专项回归
        run: node scripts/check-karing-process-attribution.mjs

      - name: 运行前端成熟度专项回归
        run: node scripts/check-karing-ui-maturity.mjs

      - name: 运行 Rust Clippy`,
  'UI maturity regression step',
)

replaceOnce(
  `          check_contains src/components/connection/connection-detail.tsx "position: 'sticky'" '详情底部操作栏固定可见'
`,
  `          check_contains src/components/connection/connection-detail.tsx "position: 'sticky'" '详情底部操作栏固定可见'
          check_contains src/components/base/adaptive-dialog.tsx "useMediaQuery(theme.breakpoints.down('sm'))" '复杂对话框仅在小屏切换全屏'
          check_contains src/components/rule/diversion-manager/project-panel.tsx 'MoreVertRounded' '应用规则低频操作已收进更多菜单'
          check_not_contains src/components/connection/connection-rule-assistant.tsx '打开分流中心' '连接分流助手不再重复分流中心入口'
          check_contains src/components/connection/connection-row-item.tsx "flexWrap: 'wrap'" '连接列表元信息允许换行避免裁字'
          check_contains src/components/routing/routing-relations-panel.tsx 'MoreVertRounded' '应用到出口关系不再堆叠跳转图标'
`,
  'release scope UI checks',
)

replaceOnce(
  `          修复以下用户可见问题：

          - Windows 无法查询 exe 路径时，\`PID xxxx\` 不再冒充已识别程序。
          - 同一个 PID 的其他连接已拿到完整名称/路径时，会回填到占位连接记录。
          - TIME-WAIT、LISTEN、CLOSED 与 PID 0 不再污染端点候选。
          - 连接详情使用完整动态视口、独立滚动正文和固定底部操作栏，不再裁切规则、出口或按钮。
          - 安装包内部版本升级为 2.5.4，避免与旧 2.5.3 安装包混淆。
`,
  `          本轮集中完成前端成熟化与关联关系收敛：

          - 新增统一自适应对话框：手机全屏，桌面保持有边界的大型窗口和独立滚动正文。
          - 连接详情、连接列表、应用名称、程序路径、规则和出口不再依赖固定单行宽度，长文本可完整阅读。
          - 应用规则行只保留启用与编辑；查看连接、查看出口和删除收进“更多”菜单，消除按钮墙。
          - “应用规则 → 当前出口”关系直接展示，低频跳转统一收纳，不再重复堆叠连接/编辑/出口图标。
          - 连接分流助手移除重复“打开分流中心”入口，域名测试、规则提供者、匹配器和出口选择器统一窗口行为。
          - Windows 程序归因与短命 UDP/冲突保护专项回归继续保留，避免 UI 重构破坏真实分流链路。
`,
  'release notes',
)

replaceOnce(
  '          if gh release view "${RELEASE_TAG}" >/dev/null 2>&1; then',
  '          if gh release view "${RELEASE_TAG}" --repo "${GITHUB_REPOSITORY}" >/dev/null 2>&1; then',
  'release view repo scope',
)
replaceOnce(
  '            gh release delete "${RELEASE_TAG}" --yes --cleanup-tag',
  '            gh release delete "${RELEASE_TAG}" --repo "${GITHUB_REPOSITORY}" --yes --cleanup-tag',
  'release delete repo scope',
)
replaceOnce(
  `            release-assets/BUILD_INFO.txt \\
            --target "\${{ needs.review.outputs.commit }}" \\`,
  `            release-assets/BUILD_INFO.txt \\
            --repo "\${GITHUB_REPOSITORY}" \\
            --target "\${{ needs.review.outputs.commit }}" \\`,
  'release create repo scope',
)

replaceOnce(
  `          asset_count=$(gh release view "\${RELEASE_TAG}" --json assets --jq '.assets | length')
          test "$asset_count" -eq 14
          tag_sha=$(git ls-remote "https://github.com/\${GITHUB_REPOSITORY}.git" "refs/tags/\${RELEASE_TAG}" | awk '{print $1}')
          test "$tag_sha" = "\${{ needs.review.outputs.commit }}"
          gh release view "\${RELEASE_TAG}" --json url,tagName,targetCommitish,isDraft,isPrerelease,assets --jq '{url: .url, tag: .tagName, target: .targetCommitish, draft: .isDraft, prerelease: .isPrerelease, assets: [.assets[].name]}'`,
  `          release_json=$(gh api "repos/\${GITHUB_REPOSITORY}/releases/tags/\${RELEASE_TAG}")
          asset_count=$(jq '.assets | length' <<<"$release_json")
          target=$(jq -r '.target_commitish' <<<"$release_json")
          draft=$(jq -r '.draft' <<<"$release_json")
          prerelease=$(jq -r '.prerelease' <<<"$release_json")
          latest_tag=$(gh api "repos/\${GITHUB_REPOSITORY}/releases/latest" --jq '.tag_name')
          tag_sha=$(gh api "repos/\${GITHUB_REPOSITORY}/git/ref/tags/\${RELEASE_TAG}" --jq '.object.sha')

          test "$asset_count" -eq 14
          test "$target" = "\${{ needs.review.outputs.commit }}"
          test "$draft" = false
          test "$prerelease" = false
          test "$latest_tag" = "\${RELEASE_TAG}"
          test "$tag_sha" = "\${{ needs.review.outputs.commit }}"

          jq '{url: .html_url, tag: .tag_name, target: .target_commitish, draft: .draft, prerelease: .prerelease, assets: [.assets[].name]}' <<<"$release_json"`,
  'release REST verification',
)

await writeFile(workflowPath, text)
console.log('Patched permanent Karing UI maturity release workflow.')
