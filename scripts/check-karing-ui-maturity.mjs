import { readFile } from 'node:fs/promises'

const files = {
  adaptiveDialog: 'src/components/base/adaptive-dialog.tsx',
  connectionDetail: 'src/components/connection/connection-detail.tsx',
  connectionRow: 'src/components/connection/connection-row-item.tsx',
  connectionAssistant:
    'src/components/connection/connection-rule-assistant.tsx',
  diversionManager: 'src/components/rule/diversion-manager/manager.tsx',
  projectPanel: 'src/components/rule/diversion-manager/project-panel.tsx',
  detectedPrograms:
    'src/components/rule/diversion-manager/detected-programs-panel.tsx',
  projectEditor:
    'src/components/rule/diversion-manager/project-editor-dialog.tsx',
  actionPicker: 'src/components/rule/diversion-manager/action-picker.tsx',
  matcherTypePicker:
    'src/components/rule/diversion-manager/matcher-type-picker.tsx',
  matcherValuePicker:
    'src/components/rule/diversion-manager/matcher-value-picker.tsx',
  groupCreate: 'src/components/rule/diversion-manager/group-create-dialog.tsx',
  domainDetector: 'src/components/rule/diversion-detector.tsx',
  providerButton: 'src/components/rule/provider-button.tsx',
  routingRelations: 'src/components/routing/routing-relations-panel.tsx',
  focusedPolicy: 'src/components/routing/focused-policy-panel.tsx',
  connectionProject: 'src/components/routing/connection-project-card.tsx',
}

const source = Object.fromEntries(
  await Promise.all(
    Object.entries(files).map(async ([key, path]) => [
      key,
      await readFile(path, 'utf8'),
    ]),
  ),
)

const failures = []

const requireText = (key, text, label) => {
  if (!source[key].includes(text)) failures.push(`${label}: missing ${text}`)
}

const forbidText = (key, text, label) => {
  if (source[key].includes(text))
    failures.push(`${label}: still contains ${text}`)
}

requireText(
  'adaptiveDialog',
  "useMediaQuery(theme.breakpoints.down('sm'))",
  'adaptive dialog switches to full screen only on small screens',
)
requireText(
  'adaptiveDialog',
  "maxHeight: { xs: '100dvh', sm: 'calc(100dvh - 32px)' }",
  'adaptive dialog is bounded on desktop',
)

for (const key of [
  'connectionAssistant',
  'diversionManager',
  'projectEditor',
  'actionPicker',
  'matcherTypePicker',
  'matcherValuePicker',
  'groupCreate',
  'domainDetector',
  'providerButton',
]) {
  requireText(key, '<AdaptiveDialog', `${key} uses the shared adaptive dialog`)
}

forbidText(
  'connectionDetail',
  'noWrap',
  'connection detail must not hide primary information with noWrap',
)
requireText(
  'connectionDetail',
  "direction={{ xs: 'column', sm: 'row' }}",
  'connection detail actions adapt on narrow windows',
)
requireText(
  'connectionRow',
  "flexWrap: 'wrap'",
  'connection list metadata can wrap instead of fixed percentage clipping',
)
forbidText(
  'connectionRow',
  "maxWidth: '46%'",
  'connection list no longer uses hard percentage clipping',
)
forbidText(
  'connectionRow',
  "maxWidth: '34%'",
  'connection list no longer uses hard percentage clipping',
)

requireText(
  'projectPanel',
  'MoreVertRounded',
  'application rules collapse low-frequency actions into a menu',
)
forbidText(
  'projectPanel',
  'Tooltip title="查看连接"',
  'application rules must not restore the old per-row connection icon',
)
forbidText(
  'projectPanel',
  'Tooltip title="删除应用分流"',
  'application rules must not restore the old per-row delete icon',
)
forbidText(
  'projectPanel',
  '<OverflowReveal',
  'application rule rows must show names and outlets directly',
)
requireText(
  'detectedPrograms',
  "'设置分流'",
  'detected applications expose an explicit primary action',
)

forbidText(
  'connectionAssistant',
  '打开分流中心',
  'connection routing assistant must not duplicate the diversion center entry',
)
requireText(
  'routingRelations',
  'MoreVertRounded',
  'application-to-outlet relations collapse secondary navigation',
)
forbidText(
  'routingRelations',
  '<OverflowReveal',
  'application-to-outlet relations must show names directly',
)
forbidText(
  'focusedPolicy',
  '<OverflowReveal',
  'focused outlet panel must show the current outlet directly',
)
requireText(
  'focusedPolicy',
  "overflowWrap: 'anywhere'",
  'focused outlet panel allows long names to wrap',
)
requireText(
  'connectionProject',
  'gridTemplateColumns:',
  'routing relation summary keeps a responsive grid',
)
requireText(
  'connectionProject',
  "xs: '1fr'",
  'routing relation summary stacks on narrow windows',
)

if (failures.length > 0) {
  console.error('Karing UI maturity regression failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Karing UI maturity regression passed.')
console.log(`Checked ${Object.keys(files).length} UI source files.`)
