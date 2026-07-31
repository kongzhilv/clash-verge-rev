import {
  AutoAwesomeRounded,
  EditRounded,
  SettingsRounded,
  VisibilityOffRounded,
  VisibilityRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from '@mui/material'
import type { ReactNode } from 'react'

import type { DiversionConfig, DiversionGroup } from './model'
import {
  SIMPLE_ACTIONS,
  getBuiltinAction,
  isSimpleAction,
  type BuiltinGroup,
  type SimpleAction,
  withBuiltinAction,
} from './presets'

interface SimplePanelProps {
  config: DiversionConfig
  builtinGroups: BuiltinGroup[]
  onConfigChange: (patch: Partial<DiversionConfig>) => void
  onBuiltinGroupsChange: (groups: BuiltinGroup[]) => void
  onGroupChange: (index: number, patch: Partial<DiversionGroup>) => void
  onOpenAdvanced: () => void
}

interface SectionProps {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
}

const Section = ({ title, description, action, children }: SectionProps) => (
  <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2 }}>
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1}
      sx={{ p: 2, alignItems: { sm: 'center' } }}
    >
      <Box sx={{ flex: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        {description && (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {description}
          </Typography>
        )}
      </Box>
      {action}
    </Stack>
    <Divider />
    <Stack divider={<Divider flexItem />}>{children}</Stack>
  </Box>
)

interface RuleRowProps {
  name: string
  description?: string
  rules?: string[]
  action: string
  advancedLabel?: string
  disabled?: boolean
  disabledText?: string
  onActionChange: (action: SimpleAction) => void
  allowNone?: boolean
}

const RuleRow = ({
  name,
  description,
  rules,
  action,
  advancedLabel,
  disabled = false,
  disabledText,
  onActionChange,
  allowNone = true,
}: RuleRowProps) => (
  <Stack
    direction={{ xs: 'column', sm: 'row' }}
    spacing={1.5}
    sx={{ p: 2, alignItems: { sm: 'center' } }}
  >
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography sx={{ fontWeight: 600 }}>{name}</Typography>
      {(description || disabledText) && (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {disabledText || description}
        </Typography>
      )}
      {rules && rules.length > 0 && (
        <Stack
          direction="row"
          spacing={0.5}
          sx={{ mt: 0.75, flexWrap: 'wrap' }}
        >
          {rules.map((rule) => (
            <Chip
              key={rule}
              size="small"
              variant="outlined"
              label={rule}
              sx={{ mb: 0.5 }}
            />
          ))}
        </Stack>
      )}
    </Box>

    <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 190 } }}>
      <InputLabel>处理方式</InputLabel>
      <Select
        label="处理方式"
        value={action}
        disabled={disabled}
        onChange={(event) =>
          onActionChange(event.target.value as SimpleAction)
        }
      >
        {advancedLabel && (
          <MenuItem value="advanced" disabled>
            {advancedLabel}
          </MenuItem>
        )}
        {SIMPLE_ACTIONS.filter(
          ([value]) => allowNone || value !== 'none',
        ).map(([value, label]) => (
          <MenuItem key={value} value={value}>
            {label}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  </Stack>
)

const customGroupAction = (group: DiversionGroup) => {
  if (!group.enabled || group.action === 'none') return 'none'
  return isSimpleAction(group.action) ? group.action : 'advanced'
}

const advancedActionLabel = (group: DiversionGroup) => {
  if (group.action === 'policy') return `高级：${group.policy || '指定策略组'}`
  if (group.action === 'reject-drop') return '高级：静默拦截'
  return undefined
}

export const SimplePanel = ({
  config,
  builtinGroups,
  onConfigChange,
  onBuiltinGroupsChange,
  onGroupChange,
  onOpenAdvanced,
}: SimplePanelProps) => {
  const hideUnused = config['hide-unused-groups']
  const region = config['auto-country-rules']
    ? config['country-or-region']
    : ''
  const visibleBuiltins = hideUnused
    ? builtinGroups.filter(
        (group) =>
          getBuiltinAction(group) !== 'none' ||
          group.presetId === `${region}-direct`,
      )
    : builtinGroups
  const visibleCustomGroups = hideUnused
    ? config.groups.filter((group) => customGroupAction(group) !== 'none')
    : config.groups

  const updateBuiltin = (id: string, action: SimpleAction) => {
    if (action !== 'none') onConfigChange({ enabled: true })
    onBuiltinGroupsChange(
      builtinGroups.map((group) =>
        group.id === id ? withBuiltinAction(group, action) : group,
      ),
    )
  }

  const updateRegion = (value: '' | 'cn' | 'ir') => {
    onConfigChange({
      ...(value ? { enabled: true } : {}),
      'auto-country-rules': value !== '',
      'country-or-region': value,
    })
    if (value) {
      onBuiltinGroupsChange(
        builtinGroups.map((group) =>
          group.presetId === `${value}-direct`
            ? withBuiltinAction(group, 'none')
            : group,
        ),
      )
    }
  }

  const enableRecommendedBasics = () => {
    onConfigChange({
      enabled: true,
      'private-network-direct': true,
      'disable-isp-rules': false,
      fallback: 'current',
      'fallback-policy': undefined,
    })
  }

  return (
    <Stack spacing={2}>
      <Alert severity="info">
        这里按 Karing 新手模式设计：只需要决定“这类流量走哪里”。域名、IP、Rule
        Set、OR/AND 等规则内容仍保留在高级编辑中。
      </Alert>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ justifyContent: 'space-between' }}
      >
        <Button
          variant="contained"
          startIcon={<AutoAwesomeRounded />}
          onClick={enableRecommendedBasics}
        >
          启用推荐基础设置
        </Button>
        <Button startIcon={<SettingsRounded />} onClick={onOpenAdvanced}>
          高级编辑
        </Button>
      </Stack>

      <Section
        title="基础分流"
        description="对应 Karing 的私有网络、ISP 规则、国家与地区和隐藏未启用分流组。"
      >
        <Stack sx={{ p: 2 }} spacing={0.5}>
          <FormControlLabel
            control={
              <Switch
                checked={config.enabled}
                onChange={(_, checked) => onConfigChange({ enabled: checked })}
              />
            }
            label="启用分流规则"
          />
          <FormControlLabel
            control={
              <Switch
                checked={config['private-network-direct']}
                onChange={(_, checked) =>
                  onConfigChange({ 'private-network-direct': checked })
                }
              />
            }
            label="私有网络直连"
          />
          <FormControlLabel
            control={
              <Switch
                checked={!config['disable-isp-rules']}
                onChange={(_, checked) =>
                  onConfigChange({ 'disable-isp-rules': !checked })
                }
              />
            }
            label="保留机场/订阅自带分流规则"
          />
          <FormControlLabel
            control={
              <Switch
                checked={hideUnused}
                onChange={(_, checked) =>
                  onConfigChange({ 'hide-unused-groups': checked })
                }
              />
            }
            label={
              <Stack
                direction="row"
                spacing={0.75}
                sx={{ alignItems: 'center' }}
              >
                {hideUnused ? <VisibilityOffRounded /> : <VisibilityRounded />}
                <span>隐藏处理方式为“无”的规则组</span>
              </Stack>
            }
          />
        </Stack>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          sx={{ p: 2, alignItems: { sm: 'center' } }}
        >
          <Box sx={{ flex: 1 }}>
            <Typography sx={{ fontWeight: 600 }}>国家与地区自动直连</Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Karing 目前只会为 CN 和 IR 自动加入 GeoSite + GeoIP 直连规则。
            </Typography>
          </Box>
          <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 210 } }}>
            <InputLabel>国家与地区</InputLabel>
            <Select
              label="国家与地区"
              value={region}
              onChange={(event) =>
                updateRegion(event.target.value as '' | 'cn' | 'ir')
              }
            >
              <MenuItem value="">不自动添加</MenuItem>
              <MenuItem value="cn">中国大陆（CN）</MenuItem>
              <MenuItem value="ir">伊朗（IR）</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </Section>

      <Section
        title="常用规则组"
        description="首次使用时先给出推荐规则组；选择“无”不会删除规则，以后可以随时重新启用。"
      >
        {visibleBuiltins.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              所有常用规则组都已隐藏。关闭“隐藏未启用的规则组”即可重新显示。
            </Typography>
          </Box>
        ) : (
          visibleBuiltins.map((group) => {
            const managedByRegion =
              Boolean(region) && group.presetId === `${region}-direct`
            return (
              <RuleRow
                key={group.id}
                name={group.name}
                description={group.description}
                rules={group.rules}
                action={managedByRegion ? 'direct' : getBuiltinAction(group)}
                disabled={managedByRegion}
                disabledText={
                  managedByRegion
                    ? '已由上面的“国家与地区自动直连”统一管理。'
                    : undefined
                }
                onActionChange={(action) => updateBuiltin(group.id, action)}
              />
            )
          })
        )}
      </Section>

      <Section
        title="自定义规则组"
        description="和 Karing 一样，主页面只选择动作；具体匹配内容放在编辑页。"
        action={
          <Button startIcon={<EditRounded />} onClick={onOpenAdvanced}>
            添加或编辑规则
          </Button>
        }
      >
        {visibleCustomGroups.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {config.groups.length === 0
                ? '还没有自定义规则组。点击“添加或编辑规则”创建。'
                : '未启用的自定义规则组已隐藏。'}
            </Typography>
          </Box>
        ) : (
          visibleCustomGroups.map((group) => {
            const index = config.groups.findIndex((item) => item.id === group.id)
            return (
              <RuleRow
                key={group.id}
                name={group.name || '未命名规则组'}
                description={`${group.logic.toUpperCase()} · ${group.matchers.length} 个匹配项`}
                action={customGroupAction(group)}
                advancedLabel={advancedActionLabel(group)}
                onActionChange={(action) => {
                  if (action !== 'none') onConfigChange({ enabled: true })
                  onGroupChange(index, {
                    enabled: action !== 'none',
                    action,
                  })
                }}
              />
            )
          })
        )}
      </Section>

      <Section
        title="最终规则"
        description="没有命中上面任何规则的流量要怎么处理。Karing 默认使用“当前选择”。"
      >
        <RuleRow
          name="未匹配流量"
          description="建议保持“当前选择”，这样主界面换节点后不需要改规则。"
          action={isSimpleAction(config.fallback) ? config.fallback : 'advanced'}
          advancedLabel={
            config.fallback === 'policy'
              ? `高级：${config['fallback-policy'] || '指定策略组'}`
              : config.fallback === 'reject-drop'
                ? '高级：静默拦截'
                : undefined
          }
          allowNone={false}
          onActionChange={(fallback) =>
            onConfigChange({
              enabled: true,
              fallback,
              'fallback-policy': undefined,
            })
          }
        />
      </Section>
    </Stack>
  )
}

export default SimplePanel
