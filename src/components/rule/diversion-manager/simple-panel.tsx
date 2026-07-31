import {
  AutoAwesomeRounded,
  ChevronRightRounded,
  EditRounded,
  SettingsRounded,
  VisibilityOffRounded,
  VisibilityRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
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
import { useState, type ReactNode } from 'react'

import ActionPicker, { actionLabel } from './action-picker'
import type { Action, DiversionConfig, DiversionGroup } from './model'
import {
  getBuiltinAction,
  type BuiltinGroup,
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
  action: Action
  policy?: string
  disabled?: boolean
  disabledText?: string
  allowNone?: boolean
  allowDrop?: boolean
  onActionChange: (action: Action, policy?: string) => void
}

const RuleRow = ({
  name,
  description,
  action,
  policy,
  disabled = false,
  disabledText,
  allowNone = true,
  allowDrop = false,
  onActionChange,
}: RuleRowProps) => {
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
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
      </Box>

      <Button
        variant="outlined"
        endIcon={<ChevronRightRounded />}
        disabled={disabled}
        onClick={() => setPickerOpen(true)}
        sx={{
          minWidth: { xs: '100%', sm: 210 },
          justifyContent: 'space-between',
          textTransform: 'none',
        }}
      >
        {actionLabel(action, policy)}
      </Button>

      <ActionPicker
        open={pickerOpen}
        title={name}
        action={action}
        policy={policy}
        allowNone={allowNone}
        allowDrop={allowDrop}
        onClose={() => setPickerOpen(false)}
        onSelect={onActionChange}
      />
    </Stack>
  )
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
    ? config.groups.filter(
        (group) => group.enabled && group.action !== 'none',
      )
    : config.groups

  const updateBuiltin = (id: string, action: Action, policy?: string) => {
    if (action !== 'none') onConfigChange({ enabled: true })
    onBuiltinGroupsChange(
      builtinGroups.map((group) =>
        group.id === id ? withBuiltinAction(group, action, policy) : group,
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
        点击每一条规则即可弹出出口选择器；复杂规则内容会原样保留，需要时再进入高级编辑。
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
        description="决定局域网、机场自带规则和未使用规则组的处理方式。"
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
            label="局域网和私有地址直连"
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
              自动让所选国家或地区的本地网站和 IP 直接连接。
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
        description="选择“无”只会停用，不会删除规则，以后可以随时重新开启。"
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
                action={managedByRegion ? 'direct' : getBuiltinAction(group)}
                policy={group.policy}
                disabled={managedByRegion}
                disabledText={
                  managedByRegion
                    ? '已由上面的“国家与地区自动直连”统一管理。'
                    : undefined
                }
                onActionChange={(action, policy) =>
                  updateBuiltin(group.id, action, policy)
                }
              />
            )
          })
        )}
      </Section>

      <Section
        title="自定义规则组"
        description="点击规则组选择出口；具体匹配内容放在高级编辑中。"
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
            const index = config.groups.findIndex(
              (item) => item.id === group.id,
            )
            return (
              <RuleRow
                key={group.id}
                name={group.name || '未命名规则组'}
                description={`已配置 ${group.matchers.length} 个匹配条件`}
                action={group.enabled ? group.action : 'none'}
                policy={group.policy}
                allowDrop
                onActionChange={(action, policy) => {
                  if (action !== 'none') onConfigChange({ enabled: true })
                  onGroupChange(index, {
                    enabled: action !== 'none',
                    action,
                    policy: action === 'policy' ? policy : undefined,
                  })
                }}
              />
            )
          })
        )}
      </Section>

      <Section
        title="最终规则"
        description="没有命中上面任何规则的流量要怎么处理。"
      >
        <RuleRow
          name="未匹配流量"
          description="建议保持“当前选择”，主界面换节点后无需再改规则。"
          action={config.fallback}
          policy={config['fallback-policy']}
          allowNone={false}
          allowDrop
          onActionChange={(fallback, policy) =>
            onConfigChange({
              enabled: true,
              fallback,
              'fallback-policy': fallback === 'policy' ? policy : undefined,
            })
          }
        />
      </Section>
    </Stack>
  )
}

export default SimplePanel
