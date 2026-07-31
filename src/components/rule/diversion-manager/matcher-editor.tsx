import {
  ChevronRightRounded,
  DeleteOutlineRounded,
  PlaylistAddCheckRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
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
import { useState } from 'react'

import {
  createMatcherForType,
  hasMatcherValuePicker,
  MATCHER_TYPE_GROUPS,
} from './matcher-catalog'
import MatcherTypePicker from './matcher-type-picker'
import MatcherValuePicker from './matcher-value-picker'
import type { DiversionMatcher, MatcherType } from './model'

interface MatcherEditorProps {
  matcher: DiversionMatcher
  onChange: (patch: Partial<DiversionMatcher>) => void
  onDelete: () => void
}

const valueField = (type: MatcherType) => {
  if (type === 'RULE-SET') {
    return {
      label: '规则集名称或已有 provider',
      placeholder: '例如 openai-rules',
      helperText:
        '可以从已有 rule-provider 中选择，也可以在下方提供远程 URL 自动创建。',
    }
  }
  if (type === 'RULE-SET-BUILDIN') {
    return {
      label: '内置规则集',
      placeholder: 'geosite:cn、geoip:cn 或 acl:BanAD',
      helperText: '点击“选择”可直接从常用 GeoSite / GeoIP 分类中挑选。',
    }
  }
  return {
    label: '匹配内容',
    placeholder: '填写规则值',
    helperText: undefined,
  }
}

const matcherTypeLabel = (type: MatcherType) =>
  MATCHER_TYPE_GROUPS.flatMap((group) => group.options).find(
    (option) => option.type === type,
  )?.label ?? type

export const MatcherEditor = ({
  matcher,
  onChange,
  onDelete,
}: MatcherEditorProps) => {
  const [typePickerOpen, setTypePickerOpen] = useState(false)
  const [valuePickerOpen, setValuePickerOpen] = useState(false)
  const field = valueField(matcher.type)
  const showNoResolve =
    matcher.type === 'IP-CIDR' ||
    matcher.type === 'GEOIP' ||
    (matcher.type === 'RULE-SET' && matcher.behavior === 'ipcidr')

  const changeType = (type: MatcherType) => {
    const next = createMatcherForType(type)
    onChange({
      type: next.type,
      value: next.value,
      provider: next.provider,
      url: next.url,
      behavior: next.behavior,
      format: next.format,
      interval: next.interval,
      'no-resolve': next['no-resolve'] ?? false,
    })
  }

  const selectValue = (value: string) => {
    if (matcher.type === 'RULE-SET') {
      onChange({ value, provider: value, url: undefined })
      return
    }
    onChange({ value })
  }

  return (
    <Box sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1.5 }}>
      <Stack spacing={1}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1}
          sx={{ alignItems: { md: 'center' } }}
        >
          <Button
            variant="outlined"
            endIcon={<ChevronRightRounded />}
            onClick={() => setTypePickerOpen(true)}
            sx={{ minWidth: 190, justifyContent: 'space-between' }}
          >
            {matcherTypeLabel(matcher.type)}
          </Button>

          <MatcherTypePicker
            open={typePickerOpen}
            title="更换规则类型"
            onClose={() => setTypePickerOpen(false)}
            onSelect={changeType}
          />

          <TextField
            fullWidth
            size="small"
            label={field.label}
            placeholder={field.placeholder}
            helperText={field.helperText}
            value={matcher.value}
            onChange={(event) => onChange({ value: event.target.value })}
          />

          {hasMatcherValuePicker(matcher.type) && (
            <Button
              variant="outlined"
              startIcon={<PlaylistAddCheckRounded />}
              onClick={() => setValuePickerOpen(true)}
              sx={{ minWidth: 96 }}
            >
              选择
            </Button>
          )}

          <MatcherValuePicker
            open={valuePickerOpen}
            matcher={matcher}
            onClose={() => setValuePickerOpen(false)}
            onSelect={selectValue}
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
            选择的内置分类会自动转换为 Mihomo 的 GEOSITE、GEOIP 或 ACL
            rule-provider 规则。
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
                <InputLabel>规则内容类型</InputLabel>
                <Select
                  label="规则内容类型"
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
                  <MenuItem value="classical">综合规则</MenuItem>
                  <MenuItem value="domain">域名规则</MenuItem>
                  <MenuItem value="ipcidr">IP 网段规则</MenuItem>
                </Select>
              </FormControl>

              <FormControl size="small" fullWidth>
                <InputLabel>文件格式</InputLabel>
                <Select
                  label="文件格式"
                  value={matcher.format ?? 'yaml'}
                  onChange={(event) =>
                    onChange({
                      format: event.target.value as 'yaml' | 'text' | 'mrs',
                    })
                  }
                >
                  <MenuItem value="yaml">YAML</MenuItem>
                  <MenuItem value="text">纯文本</MenuItem>
                  <MenuItem
                    value="mrs"
                    disabled={(matcher.behavior ?? 'classical') === 'classical'}
                  >
                    MRS
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
            label="跳过 DNS 解析（no-resolve）"
          />
        )}
      </Stack>
    </Box>
  )
}

export default MatcherEditor
