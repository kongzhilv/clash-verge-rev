import {
  Box,
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

import { ACTIONS, type Action, type DiversionConfig } from './model'

interface SettingsPanelProps {
  config: DiversionConfig
  onChange: (patch: Partial<DiversionConfig>) => void
}

export const SettingsPanel = ({ config, onChange }: SettingsPanelProps) => (
  <Stack spacing={2}>
    <Box sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
      <Stack spacing={1.5}>
        <Typography
          variant="subtitle1"
          sx={{
            fontWeight: 700,
          }}
        >
          基础设置
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={config.enabled}
              onChange={(_, checked) => onChange({ enabled: checked })}
            />
          }
          label="启用全局分流"
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
          label="私有网络直连"
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
          label="禁用机场/订阅提供的分流规则"
        />
        {!config['disable-isp-rules'] && (
          <FormControl size="small" fullWidth>
            <InputLabel>机场规则位置</InputLabel>
            <Select
              label="机场规则位置"
              value={config['isp-rules-position']}
              onChange={(event) =>
                onChange({
                  'isp-rules-position': event.target.value as
                    | 'before-custom'
                    | 'after-custom',
                })
              }
            >
              <MenuItem value="after-custom">自定义规则优先</MenuItem>
              <MenuItem value="before-custom">机场规则优先</MenuItem>
            </Select>
          </FormControl>
        )}
      </Stack>
    </Box>

    <Box sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
      <Stack spacing={1.5}>
        <Typography
          variant="subtitle1"
          sx={{
            fontWeight: 700,
          }}
        >
          托管策略组
        </Typography>
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
                'auto-interval': Math.max(1, Number(event.target.value) || 1),
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
                'auto-tolerance': Math.max(0, Number(event.target.value) || 0),
              })
            }
          />
        </Stack>
        <FormControl size="small" fullWidth>
          <InputLabel>最终兜底动作</InputLabel>
          <Select
            label="最终兜底动作"
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
    </Box>
  </Stack>
)

export default SettingsPanel
