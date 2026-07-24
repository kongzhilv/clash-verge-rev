import { DeleteOutlineRounded } from '@mui/icons-material'
import {
  Alert,
  Box,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
} from '@mui/material'

import { MATCHER_TYPES, type DiversionMatcher, type MatcherType } from './model'

interface MatcherEditorProps {
  matcher: DiversionMatcher
  onChange: (patch: Partial<DiversionMatcher>) => void
  onDelete: () => void
}

const valueField = (type: MatcherType) => {
  if (type === 'RULE-SET') {
    return {
      label: '规则集名称/已有 provider 名称',
      placeholder: '例如 openai-rules',
      helperText:
        '填写已有 rule-provider 名称；也可以在下方提供远程 URL 自动创建 provider。',
    }
  }
  if (type === 'RULE-SET-BUILDIN') {
    return {
      label: '内置规则集',
      placeholder: 'geosite:cn、geoip:cn 或 acl:BanAD',
      helperText: '格式必须是 geosite:name、geoip:name 或 acl:name。',
    }
  }
  return {
    label: '匹配内容',
    placeholder: '填写规则值',
    helperText: undefined,
  }
}

export const MatcherEditor = ({
  matcher,
  onChange,
  onDelete,
}: MatcherEditorProps) => {
  const field = valueField(matcher.type)
  const showNoResolve =
    matcher.type === 'IP-CIDR' ||
    matcher.type === 'GEOIP' ||
    (matcher.type === 'RULE-SET' && matcher.behavior === 'ipcidr')

  return (
    <Box sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1.5 }}>
      <Stack spacing={1}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1}
          sx={{
            alignItems: { md: 'center' },
          }}
        >
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel>规则类型</InputLabel>
            <Select
              label="规则类型"
              value={matcher.type}
              onChange={(event) =>
                onChange({
                  type: event.target.value as MatcherType,
                  ...(event.target.value === 'RULE-SET-BUILDIN'
                    ? {
                        provider: undefined,
                        url: undefined,
                        behavior: undefined,
                        format: undefined,
                        interval: undefined,
                        'no-resolve': false,
                      }
                    : {}),
                })
              }
            >
              {MATCHER_TYPES.map(([type, label]) => (
                <MenuItem key={type} value={type}>
                  {label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            fullWidth
            size="small"
            label={field.label}
            placeholder={field.placeholder}
            helperText={field.helperText}
            value={matcher.value}
            onChange={(event) => onChange({ value: event.target.value })}
          />

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={matcher.enabled}
                onChange={(_, checked) => onChange({ enabled: checked })}
              />
            }
            label="启用"
          />

          <IconButton color="error" onClick={onDelete} aria-label="删除匹配项">
            <DeleteOutlineRounded />
          </IconButton>
        </Stack>

        {matcher.type === 'RULE-SET-BUILDIN' && (
          <Alert severity="info">
            内置规则集由 Karing 风格预处理器转换为 Mihomo 的 GEOSITE、GEOIP
            或已有 ACL rule-provider。
          </Alert>
        )}

        {matcher.type === 'RULE-SET' && (
          <Stack spacing={1}>
            <TextField
              size="small"
              label="远程 URL（留空则引用已有 provider）"
              value={matcher.url ?? ''}
              onChange={(event) => onChange({ url: event.target.value })}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <FormControl size="small" fullWidth>
                <InputLabel>Behavior</InputLabel>
                <Select
                  label="Behavior"
                  value={matcher.behavior ?? 'classical'}
                  onChange={(event) =>
                    onChange({
                      behavior: event.target.value as
                        | 'domain'
                        | 'ipcidr'
                        | 'classical',
                      ...(event.target.value === 'classical' &&
                      matcher.format === 'mrs'
                        ? { format: 'yaml' }
                        : {}),
                      ...(event.target.value !== 'ipcidr'
                        ? { 'no-resolve': false }
                        : {}),
                    })
                  }
                >
                  <MenuItem value="classical">classical</MenuItem>
                  <MenuItem value="domain">domain</MenuItem>
                  <MenuItem value="ipcidr">ipcidr</MenuItem>
                </Select>
              </FormControl>

              <FormControl size="small" fullWidth>
                <InputLabel>Format</InputLabel>
                <Select
                  label="Format"
                  value={matcher.format ?? 'yaml'}
                  onChange={(event) =>
                    onChange({
                      format: event.target.value as 'yaml' | 'text' | 'mrs',
                    })
                  }
                >
                  <MenuItem value="yaml">yaml</MenuItem>
                  <MenuItem value="text">text</MenuItem>
                  <MenuItem
                    value="mrs"
                    disabled={(matcher.behavior ?? 'classical') === 'classical'}
                  >
                    mrs
                  </MenuItem>
                </Select>
              </FormControl>

              <TextField
                fullWidth
                size="small"
                type="number"
                label="更新间隔（秒）"
                value={matcher.interval ?? 86400}
                onChange={(event) =>
                  onChange({
                    interval: Math.max(1, Number(event.target.value) || 86400),
                  })
                }
              />
            </Stack>
          </Stack>
        )}

        {showNoResolve && (
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={matcher['no-resolve'] === true}
                onChange={(_, checked) => onChange({ 'no-resolve': checked })}
              />
            }
            label="no-resolve"
          />
        )}
      </Stack>
    </Box>
  )
}

export default MatcherEditor
