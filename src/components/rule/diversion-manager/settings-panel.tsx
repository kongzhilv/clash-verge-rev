import { ExpandMoreRounded, PublicRounded } from '@mui/icons-material'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
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
  TextField,
  Typography,
} from '@mui/material'
import { useState } from 'react'

import { actionLabel } from './action-label'
import ActionPicker from './action-picker'
import { ACTIONS, type Action, type DiversionConfig } from './model'
import {
  getBuiltinAction,
  type BuiltinGroup,
  withBuiltinAction,
} from './presets'

interface SettingsPanelProps {
  config: DiversionConfig
  builtinGroups: BuiltinGroup[]
  onChange: (patch: Partial<DiversionConfig>) => void
  onBuiltinGroupsChange: (groups: BuiltinGroup[]) => void
}

export const SettingsPanel = ({
  config,
  builtinGroups,
  onChange,
  onBuiltinGroupsChange,
}: SettingsPanelProps) => {
  const [editingBuiltinId, setEditingBuiltinId] = useState<string | null>(null)
  const editingBuiltin = builtinGroups.find(
    (group) => group.id === editingBuiltinId,
  )

  const patchBuiltin = (
    groupId: string,
    transform: (group: BuiltinGroup) => BuiltinGroup,
  ) =>
    onBuiltinGroupsChange(
      builtinGroups.map((group) =>
        group.id === groupId ? transform(group) : group,
      ),
    )

  return (
    <Stack spacing={1.5}>
      <Box sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
        <Stack spacing={1}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            分流开关
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={config.enabled}
                onChange={(_, checked) => onChange({ enabled: checked })}
              />
            }
            label="启用自定义分流"
          />
          <FormControlLabel
            control={
              <Switch
                checked={config['private-network-direct']}
                onChange={(_, checked) =>
                  onChange({ 'private-network-direct': checked })
                }
              />
            }
            label="局域网和私有地址直连"
          />
          <FormControlLabel
            control={
              <Switch
                checked={config['hide-unused-groups']}
                onChange={(_, checked) =>
                  onChange({ 'hide-unused-groups': checked })
                }
              />
            }
            label="隐藏未被规则使用的托管策略组"
          />
          <FormControlLabel
            control={
              <Switch
                checked={config['disable-isp-rules']}
                onChange={(_, checked) =>
                  onChange({ 'disable-isp-rules': checked })
                }
              />
            }
            label="忽略订阅自带规则"
          />
          {!config['disable-isp-rules'] && (
            <FormControl size="small" fullWidth>
              <InputLabel>规则优先级</InputLabel>
              <Select
                label="规则优先级"
                value={config['isp-rules-position']}
                onChange={(event) =>
                  onChange({
                    'isp-rules-position': event.target.value as
                      | 'before-custom'
                      | 'after-custom',
                  })
                }
              >
                <MenuItem value="after-custom">我的规则优先</MenuItem>
                <MenuItem value="before-custom">订阅规则优先</MenuItem>
              </Select>
            </FormControl>
          )}
        </Stack>
      </Box>

      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2 }}>
        <Stack direction="row" spacing={1} sx={{ px: 2, py: 1.5 }}>
          <PublicRounded color="primary" />
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              常用分流
            </Typography>
            <Typography variant="body2" color="text.secondary">
              开启后直接生成对应规则；出口可随时调整。
            </Typography>
          </Box>
        </Stack>
        <Divider />
        <Stack divider={<Divider flexItem />}>
          {builtinGroups.map((group) => (
            <Stack
              key={group.id}
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              sx={{ px: 2, py: 1.25, alignItems: { sm: 'center' } }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 650 }}>{group.name}</Typography>
                {group.description && (
                  <Typography variant="caption" color="text.secondary">
                    {group.description}
                  </Typography>
                )}
              </Box>
              <Button
                size="small"
                variant="outlined"
                disabled={!group.enabled}
                onClick={() => setEditingBuiltinId(group.id)}
                sx={{ minWidth: 120 }}
              >
                {actionLabel(getBuiltinAction(group), group.policy)}
              </Button>
              <Switch
                checked={group.enabled}
                onChange={(_, checked) =>
                  patchBuiltin(group.id, (current) => ({
                    ...current,
                    enabled: checked,
                    action:
                      checked && current.action === 'none'
                        ? 'current'
                        : current.action,
                  }))
                }
                slotProps={{ input: { 'aria-label': `启用 ${group.name}` } }}
              />
            </Stack>
          ))}
        </Stack>
      </Box>

      {editingBuiltin && (
        <ActionPicker
          open
          title={`${editingBuiltin.name}的出口`}
          action={getBuiltinAction(editingBuiltin)}
          policy={editingBuiltin.policy}
          allowDrop
          onClose={() => setEditingBuiltinId(null)}
          onSelect={(action, policy) => {
            patchBuiltin(editingBuiltin.id, (group) =>
              withBuiltinAction(group, action, policy),
            )
            setEditingBuiltinId(null)
          }}
        />
      )}

      <Accordion
        disableGutters
        elevation={0}
        sx={{
          border: 1,
          borderColor: 'divider',
          borderRadius: '8px !important',
          '&::before': { display: 'none' },
        }}
      >
        <AccordionSummary expandIcon={<ExpandMoreRounded />}>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              高级策略
            </Typography>
            <Typography variant="caption" color="text.secondary">
              托管组名称、自动测速和最终兜底。
            </Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={1.5}>
            <TextField
              size="small"
              label="当前选择策略组名称"
              value={config['current-group-name']}
              onChange={(event) =>
                onChange({ 'current-group-name': event.target.value })
              }
            />
            <TextField
              size="small"
              label="自动选择策略组名称"
              value={config['auto-group-name']}
              onChange={(event) =>
                onChange({ 'auto-group-name': event.target.value })
              }
            />
            <TextField
              size="small"
              label="自动选择测试 URL"
              value={config['auto-url']}
              onChange={(event) => onChange({ 'auto-url': event.target.value })}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                fullWidth
                size="small"
                type="number"
                label="测试间隔（秒）"
                value={config['auto-interval']}
                onChange={(event) =>
                  onChange({
                    'auto-interval': Math.max(
                      1,
                      Number(event.target.value) || 1,
                    ),
                  })
                }
              />
              <TextField
                fullWidth
                size="small"
                type="number"
                label="容差（毫秒）"
                value={config['auto-tolerance']}
                onChange={(event) =>
                  onChange({
                    'auto-tolerance': Math.max(
                      0,
                      Number(event.target.value) || 0,
                    ),
                  })
                }
              />
            </Stack>
            <FormControl size="small" fullWidth>
              <InputLabel>最终兜底</InputLabel>
              <Select
                label="最终兜底"
                value={config.fallback}
                onChange={(event) =>
                  onChange({ fallback: event.target.value as Action })
                }
              >
                {ACTIONS.filter(([action]) => action !== 'none').map(
                  ([action, label]) => (
                    <MenuItem key={action} value={action}>
                      {label}
                    </MenuItem>
                  ),
                )}
              </Select>
            </FormControl>
            {config.fallback === 'policy' && (
              <TextField
                size="small"
                label="兜底策略组名称"
                value={config['fallback-policy'] ?? ''}
                onChange={(event) =>
                  onChange({ 'fallback-policy': event.target.value })
                }
              />
            )}
          </Stack>
        </AccordionDetails>
      </Accordion>
    </Stack>
  )
}

export default SettingsPanel
