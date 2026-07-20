import {
  AddRounded,
  ArrowDownwardRounded,
  ArrowUpwardRounded,
  CloseRounded,
  DeleteOutlineRounded,
  ExpandMoreRounded,
  SaveRounded,
  TuneRounded,
} from '@mui/icons-material'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  AppBar,
  Box,
  Button,
  Dialog,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material'
import { dump, load } from 'js-yaml'
import { useCallback, useMemo, useState } from 'react'

import { readProfileFile, saveProfileFile } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

const CONFIG_KEY = 'x-karing-diversion'

const MATCHER_TYPES = [
  ['DOMAIN-SUFFIX', '域名后缀'],
  ['DOMAIN', '完整域名'],
  ['DOMAIN-KEYWORD', '域名关键词'],
  ['DOMAIN-REGEX', '域名正则'],
  ['IP-CIDR', 'IP CIDR'],
  ['DST-PORT', '目标端口'],
  ['NETWORK', '协议'],
  ['GEOSITE', 'GeoSite'],
  ['GEOIP', 'GeoIP'],
  ['RULE-SET', 'Rule Set'],
  ['PROCESS-NAME', '进程名称'],
  ['PROCESS-PATH', '进程路径'],
] as const

const ACTIONS = [
  ['none', '无'],
  ['current', '当前选择'],
  ['auto-select', '自动选择'],
  ['direct', '直连'],
  ['reject', '拦截'],
  ['reject-drop', '静默拦截'],
  ['policy', '指定策略组'],
] as const

type Action = (typeof ACTIONS)[number][0]
type MatcherType = (typeof MATCHER_TYPES)[number][0]

interface DiversionMatcher {
  enabled: boolean
  type: MatcherType
  value: string
  'no-resolve'?: boolean
  provider?: string
  url?: string
  behavior?: 'domain' | 'ipcidr' | 'classical'
  format?: 'yaml' | 'text' | 'mrs'
  interval?: number
}

interface DiversionGroup {
  name: string
  enabled: boolean
  logic: 'or' | 'and'
  action: Action
  policy?: string
  matchers: DiversionMatcher[]
}

interface DiversionConfig {
  enabled: boolean
  'private-network-direct': boolean
  'disable-isp-rules': boolean
  'isp-rules-position': 'before-custom' | 'after-custom'
  'current-group-name': string
  'auto-group-name': string
  'auto-url': string
  'auto-interval': number
  'auto-tolerance': number
  fallback: Action
  'fallback-policy'?: string
  groups: DiversionGroup[]
}

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const makeMatcher = (): DiversionMatcher => ({
  enabled: true,
  type: 'DOMAIN-SUFFIX',
  value: '',
})

const makeGroup = (index: number): DiversionGroup => ({
  name: `自定义分流组 ${index + 1}`,
  enabled: true,
  logic: 'or',
  action: 'current',
  matchers: [makeMatcher()],
})

const defaultConfig = (): DiversionConfig => ({
  enabled: false,
  'private-network-direct': true,
  'disable-isp-rules': false,
  'isp-rules-position': 'after-custom',
  'current-group-name': 'CVR-当前选择',
  'auto-group-name': 'CVR-自动选择',
  'auto-url': 'https://www.gstatic.com/generate_204',
  'auto-interval': 300,
  'auto-tolerance': 50,
  fallback: 'current',
  groups: [],
})

const normalizeMatcher = (value: unknown): DiversionMatcher => {
  const raw = isRecord(value) ? value : {}
  const type = MATCHER_TYPES.some(([item]) => item === raw.type)
    ? (raw.type as MatcherType)
    : 'DOMAIN-SUFFIX'

  return {
    enabled: raw.enabled !== false,
    type,
    value: typeof raw.value === 'string' ? raw.value : '',
    'no-resolve': raw['no-resolve'] === true,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
    url: typeof raw.url === 'string' ? raw.url : undefined,
    behavior:
      raw.behavior === 'domain' ||
      raw.behavior === 'ipcidr' ||
      raw.behavior === 'classical'
        ? raw.behavior
        : 'classical',
    format:
      raw.format === 'text' || raw.format === 'mrs' ? raw.format : 'yaml',
    interval:
      typeof raw.interval === 'number' && raw.interval > 0
        ? raw.interval
        : 86400,
  }
}

const normalizeGroup = (value: unknown, index: number): DiversionGroup => {
  const raw = isRecord(value) ? value : {}
  const action = ACTIONS.some(([item]) => item === raw.action)
    ? (raw.action as Action)
    : 'current'

  return {
    name:
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name
        : `自定义分流组 ${index + 1}`,
    enabled: raw.enabled !== false,
    logic: raw.logic === 'and' ? 'and' : 'or',
    action,
    policy: typeof raw.policy === 'string' ? raw.policy : undefined,
    matchers: Array.isArray(raw.matchers)
      ? raw.matchers.map(normalizeMatcher)
      : [makeMatcher()],
  }
}

const normalizeConfig = (value: unknown): DiversionConfig => {
  const defaults = defaultConfig()
  const raw = isRecord(value) ? value : {}
  const fallback = ACTIONS.some(([item]) => item === raw.fallback)
    ? (raw.fallback as Action)
    : defaults.fallback

  return {
    enabled: raw.enabled === true,
    'private-network-direct': raw['private-network-direct'] !== false,
    'disable-isp-rules': raw['disable-isp-rules'] === true,
    'isp-rules-position':
      raw['isp-rules-position'] === 'before-custom'
        ? 'before-custom'
        : 'after-custom',
    'current-group-name':
      typeof raw['current-group-name'] === 'string'
        ? raw['current-group-name']
        : defaults['current-group-name'],
    'auto-group-name':
      typeof raw['auto-group-name'] === 'string'
        ? raw['auto-group-name']
        : defaults['auto-group-name'],
    'auto-url':
      typeof raw['auto-url'] === 'string'
        ? raw['auto-url']
        : defaults['auto-url'],
    'auto-interval':
      typeof raw['auto-interval'] === 'number'
        ? raw['auto-interval']
        : defaults['auto-interval'],
    'auto-tolerance':
      typeof raw['auto-tolerance'] === 'number'
        ? raw['auto-tolerance']
        : defaults['auto-tolerance'],
    fallback,
    'fallback-policy':
      typeof raw['fallback-policy'] === 'string'
        ? raw['fallback-policy']
        : undefined,
    groups: Array.isArray(raw.groups)
      ? raw.groups.map(normalizeGroup)
      : defaults.groups,
  }
}

const cleanMatcher = (matcher: DiversionMatcher): UnknownRecord => {
  const result: UnknownRecord = {
    enabled: matcher.enabled,
    type: matcher.type,
    value: matcher.value.trim(),
  }

  if (matcher['no-resolve']) result['no-resolve'] = true
  if (matcher.type === 'RULE-SET') {
    if (matcher.provider?.trim()) result.provider = matcher.provider.trim()
    if (matcher.url?.trim()) result.url = matcher.url.trim()
    result.behavior = matcher.behavior ?? 'classical'
    result.format = matcher.format ?? 'yaml'
    result.interval = matcher.interval ?? 86400
  }

  return result
}

const cleanConfig = (config: DiversionConfig): UnknownRecord => ({
  ...config,
  'current-group-name': config['current-group-name'].trim(),
  'auto-group-name': config['auto-group-name'].trim(),
  'auto-url': config['auto-url'].trim(),
  groups: config.groups.map((group) => ({
    name: group.name.trim(),
    enabled: group.enabled,
    logic: group.logic,
    action: group.action,
    ...(group.action === 'policy' && group.policy?.trim()
      ? { policy: group.policy.trim() }
      : {}),
    matchers: group.matchers.map(cleanMatcher),
  })),
  ...(config.fallback === 'policy' && config['fallback-policy']?.trim()
    ? { 'fallback-policy': config['fallback-policy'].trim() }
    : {}),
})

export const DiversionManager = () => {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mergeConfig, setMergeConfig] = useState<UnknownRecord>({})
  const [config, setConfig] = useState<DiversionConfig>(defaultConfig)

  const enabledGroupCount = useMemo(
    () => config.groups.filter((group) => group.enabled && group.action !== 'none').length,
    [config.groups],
  )

  const openManager = useCallback(async () => {
    setOpen(true)
    setLoading(true)
    try {
      const content = await readProfileFile('Merge')
      const parsed = content.trim() ? load(content) : {}
      const merge = isRecord(parsed) ? parsed : {}
      setMergeConfig(merge)
      setConfig(normalizeConfig(merge[CONFIG_KEY]))
    } catch (error) {
      showNotice.error(error)
    } finally {
      setLoading(false)
    }
  }, [])

  const updateGroup = (index: number, patch: Partial<DiversionGroup>) => {
    setConfig((previous) => ({
      ...previous,
      groups: previous.groups.map((group, itemIndex) =>
        itemIndex === index ? { ...group, ...patch } : group,
      ),
    }))
  }

  const updateMatcher = (
    groupIndex: number,
    matcherIndex: number,
    patch: Partial<DiversionMatcher>,
  ) => {
    setConfig((previous) => ({
      ...previous,
      groups: previous.groups.map((group, itemIndex) =>
        itemIndex === groupIndex
          ? {
              ...group,
              matchers: group.matchers.map((matcher, childIndex) =>
                childIndex === matcherIndex
                  ? { ...matcher, ...patch }
                  : matcher,
              ),
            }
          : group,
      ),
    }))
  }

  const moveGroup = (index: number, direction: -1 | 1) => {
    setConfig((previous) => {
      const target = index + direction
      if (target < 0 || target >= previous.groups.length) return previous
      const groups = [...previous.groups]
      ;[groups[index], groups[target]] = [groups[target], groups[index]]
      return { ...previous, groups }
    })
  }

  const save = useCallback(async () => {
    if (
      config.enabled &&
      (!config['current-group-name'].trim() || !config['auto-group-name'].trim())
    ) {
      showNotice.error('当前选择和自动选择策略组名称不能为空')
      return
    }

    const emptyEnabledGroup = config.groups.find(
      (group) =>
        group.enabled &&
        group.action !== 'none' &&
        (!group.name.trim() || !group.matchers.some((matcher) => matcher.value.trim())),
    )
    if (emptyEnabledGroup) {
      showNotice.error(`分流组“${emptyEnabledGroup.name || '未命名'}”缺少有效规则`)
      return
    }

    setSaving(true)
    try {
      const nextMerge = { ...mergeConfig, [CONFIG_KEY]: cleanConfig(config) }
      const content = dump(nextMerge, {
        noRefs: true,
        lineWidth: 120,
        noCompatMode: true,
      })
      const valid = await saveProfileFile('Merge', content)
      if (!valid) throw new Error('Mihomo 配置校验未通过，原配置已恢复')
      setMergeConfig(nextMerge)
      showNotice.success('分流配置已保存并应用')
      setOpen(false)
    } catch (error) {
      showNotice.error(error)
    } finally {
      setSaving(false)
    }
  }, [config, mergeConfig])

  return (
    <>
      <Tooltip title="Karing 风格分流管理">
        <Button
          size="small"
          variant="outlined"
          startIcon={<TuneRounded />}
          onClick={openManager}
        >
          分流管理
        </Button>
      </Tooltip>

      <Dialog fullScreen open={open} onClose={() => !saving && setOpen(false)}>
        <AppBar position="sticky" color="default" elevation={1}>
          <Toolbar sx={{ gap: 1 }}>
            <IconButton edge="start" onClick={() => setOpen(false)} disabled={saving}>
              <CloseRounded />
            </IconButton>
            <Box sx={{ flex: 1 }}>
              <Typography variant="h6">分流管理</Typography>
              <Typography variant="caption" color="text.secondary">
                已启用 {enabledGroupCount} 个自定义分流组
              </Typography>
            </Box>
            <Button
              variant="contained"
              startIcon={<SaveRounded />}
              onClick={save}
              disabled={loading || saving}
            >
              {saving ? '正在校验…' : '保存并应用'}
            </Button>
          </Toolbar>
        </AppBar>

        <Box sx={{ maxWidth: 1100, width: '100%', mx: 'auto', p: 2 }}>
          {loading ? (
            <Typography color="text.secondary">正在读取全局 Merge 配置…</Typography>
          ) : (
            <Stack spacing={2}>
              <Box sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
                <Stack spacing={1.5}>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={config.enabled}
                        onChange={(_, checked) =>
                          setConfig((previous) => ({ ...previous, enabled: checked }))
                        }
                      />
                    }
                    label="启用全局分流"
                  />
                  <FormControlLabel
                    control={
                      <Switch
                        checked={config['private-network-direct']}
                        onChange={(_, checked) =>
                          setConfig((previous) => ({
                            ...previous,
                            'private-network-direct': checked,
                          }))
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
                          setConfig((previous) => ({
                            ...previous,
                            'disable-isp-rules': checked,
                          }))
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
                          setConfig((previous) => ({
                            ...previous,
                            'isp-rules-position': event.target.value as
                              | 'before-custom'
                              | 'after-custom',
                          }))
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
                <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>
                  托管策略组
                </Typography>
                <Stack spacing={1.5}>
                  <TextField
                    size="small"
                    label="当前选择策略组名称"
                    value={config['current-group-name']}
                    onChange={(event) =>
                      setConfig((previous) => ({
                        ...previous,
                        'current-group-name': event.target.value,
                      }))
                    }
                  />
                  <TextField
                    size="small"
                    label="自动选择策略组名称"
                    value={config['auto-group-name']}
                    onChange={(event) =>
                      setConfig((previous) => ({
                        ...previous,
                        'auto-group-name': event.target.value,
                      }))
                    }
                  />
                  <TextField
                    size="small"
                    label="自动选择测试 URL"
                    value={config['auto-url']}
                    onChange={(event) =>
                      setConfig((previous) => ({
                        ...previous,
                        'auto-url': event.target.value,
                      }))
                    }
                  />
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <TextField
                      fullWidth
                      size="small"
                      type="number"
                      label="测试间隔（秒）"
                      value={config['auto-interval']}
                      onChange={(event) =>
                        setConfig((previous) => ({
                          ...previous,
                          'auto-interval': Math.max(1, Number(event.target.value) || 1),
                        }))
                      }
                    />
                    <TextField
                      fullWidth
                      size="small"
                      type="number"
                      label="容差（毫秒）"
                      value={config['auto-tolerance']}
                      onChange={(event) =>
                        setConfig((previous) => ({
                          ...previous,
                          'auto-tolerance': Math.max(0, Number(event.target.value) || 0),
                        }))
                      }
                    />
                  </Stack>
                  <FormControl size="small" fullWidth>
                    <InputLabel>最终兜底动作</InputLabel>
                    <Select
                      label="最终兜底动作"
                      value={config.fallback}
                      onChange={(event) =>
                        setConfig((previous) => ({
                          ...previous,
                          fallback: event.target.value as Action,
                        }))
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
                        setConfig((previous) => ({
                          ...previous,
                          'fallback-policy': event.target.value,
                        }))
                      }
                    />
                  )}
                </Stack>
              </Box>

              <Box>
                <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                  <Box>
                    <Typography variant="subtitle1" fontWeight={700}>
                      自定义分流组
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      列表顺序就是最终 Mihomo 规则顺序，越靠上优先级越高。
                    </Typography>
                  </Box>
                  <Button
                    startIcon={<AddRounded />}
                    onClick={() =>
                      setConfig((previous) => ({
                        ...previous,
                        groups: [...previous.groups, makeGroup(previous.groups.length)],
                      }))
                    }
                  >
                    新建分流组
                  </Button>
                </Stack>

                {config.groups.length === 0 ? (
                  <Box sx={{ p: 4, textAlign: 'center', border: 1, borderStyle: 'dashed', borderColor: 'divider', borderRadius: 2 }}>
                    <Typography color="text.secondary">还没有自定义分流组</Typography>
                  </Box>
                ) : (
                  config.groups.map((group, groupIndex) => (
                    <Accordion key={`${group.name}-${groupIndex}`} defaultExpanded={groupIndex === 0}>
                      <AccordionSummary expandIcon={<ExpandMoreRounded />}>
                        <Stack direction="row" alignItems="center" spacing={1} sx={{ width: '100%', pr: 1 }}>
                          <Switch
                            size="small"
                            checked={group.enabled}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(_, checked) => updateGroup(groupIndex, { enabled: checked })}
                          />
                          <Typography sx={{ flex: 1, fontWeight: 600 }}>
                            {group.name || '未命名分流组'}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {group.logic.toUpperCase()} · {group.matchers.length} 项
                          </Typography>
                        </Stack>
                      </AccordionSummary>
                      <AccordionDetails>
                        <Stack spacing={1.5}>
                          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                            <TextField
                              fullWidth
                              size="small"
                              label="分流组名称"
                              value={group.name}
                              onChange={(event) => updateGroup(groupIndex, { name: event.target.value })}
                            />
                            <FormControl size="small" sx={{ minWidth: 130 }}>
                              <InputLabel>条件逻辑</InputLabel>
                              <Select
                                label="条件逻辑"
                                value={group.logic}
                                onChange={(event) =>
                                  updateGroup(groupIndex, {
                                    logic: event.target.value as 'or' | 'and',
                                  })
                                }
                              >
                                <MenuItem value="or">OR（满足一项）</MenuItem>
                                <MenuItem value="and">AND（满足全部）</MenuItem>
                              </Select>
                            </FormControl>
                            <FormControl size="small" sx={{ minWidth: 150 }}>
                              <InputLabel>匹配动作</InputLabel>
                              <Select
                                label="匹配动作"
                                value={group.action}
                                onChange={(event) =>
                                  updateGroup(groupIndex, {
                                    action: event.target.value as Action,
                                  })
                                }
                              >
                                {ACTIONS.map(([action, label]) => (
                                  <MenuItem key={action} value={action}>
                                    {label}
                                  </MenuItem>
                                ))}
                              </Select>
                            </FormControl>
                          </Stack>

                          {group.action === 'policy' && (
                            <TextField
                              size="small"
                              label="指定策略组或节点名称"
                              value={group.policy ?? ''}
                              onChange={(event) => updateGroup(groupIndex, { policy: event.target.value })}
                            />
                          )}

                          <Divider />

                          {group.matchers.map((matcher, matcherIndex) => (
                            <Box
                              key={`${matcher.type}-${matcherIndex}`}
                              sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1.5 }}
                            >
                              <Stack spacing={1}>
                                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }}>
                                  <FormControl size="small" sx={{ minWidth: 150 }}>
                                    <InputLabel>规则类型</InputLabel>
                                    <Select
                                      label="规则类型"
                                      value={matcher.type}
                                      onChange={(event) =>
                                        updateMatcher(groupIndex, matcherIndex, {
                                          type: event.target.value as MatcherType,
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
                                    label={matcher.type === 'RULE-SET' ? '规则集名称/已有 provider 名称' : '匹配内容'}
                                    value={matcher.value}
                                    onChange={(event) =>
                                      updateMatcher(groupIndex, matcherIndex, {
                                        value: event.target.value,
                                      })
                                    }
                                  />
                                  <FormControlLabel
                                    control={
                                      <Switch
                                        size="small"
                                        checked={matcher.enabled}
                                        onChange={(_, checked) =>
                                          updateMatcher(groupIndex, matcherIndex, {
                                            enabled: checked,
                                          })
                                        }
                                      />
                                    }
                                    label="启用"
                                  />
                                  <IconButton
                                    color="error"
                                    onClick={() =>
                                      updateGroup(groupIndex, {
                                        matchers: group.matchers.filter(
                                          (_, itemIndex) => itemIndex !== matcherIndex,
                                        ),
                                      })
                                    }
                                  >
                                    <DeleteOutlineRounded />
                                  </IconButton>
                                </Stack>

                                {matcher.type === 'RULE-SET' && (
                                  <Stack spacing={1}>
                                    <TextField
                                      size="small"
                                      label="远程 URL（留空则引用已有 provider）"
                                      value={matcher.url ?? ''}
                                      onChange={(event) =>
                                        updateMatcher(groupIndex, matcherIndex, {
                                          url: event.target.value,
                                        })
                                      }
                                    />
                                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                                      <FormControl size="small" fullWidth>
                                        <InputLabel>Behavior</InputLabel>
                                        <Select
                                          label="Behavior"
                                          value={matcher.behavior ?? 'classical'}
                                          onChange={(event) =>
                                            updateMatcher(groupIndex, matcherIndex, {
                                              behavior: event.target.value as
                                                | 'domain'
                                                | 'ipcidr'
                                                | 'classical',
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
                                            updateMatcher(groupIndex, matcherIndex, {
                                              format: event.target.value as
                                                | 'yaml'
                                                | 'text'
                                                | 'mrs',
                                            })
                                          }
                                        >
                                          <MenuItem value="yaml">yaml</MenuItem>
                                          <MenuItem value="text">text</MenuItem>
                                          <MenuItem value="mrs">mrs</MenuItem>
                                        </Select>
                                      </FormControl>
                                      <TextField
                                        fullWidth
                                        size="small"
                                        type="number"
                                        label="更新间隔（秒）"
                                        value={matcher.interval ?? 86400}
                                        onChange={(event) =>
                                          updateMatcher(groupIndex, matcherIndex, {
                                            interval: Math.max(
                                              1,
                                              Number(event.target.value) || 86400,
                                            ),
                                          })
                                        }
                                      />
                                    </Stack>
                                  </Stack>
                                )}

                                <FormControlLabel
                                  control={
                                    <Switch
                                      size="small"
                                      checked={matcher['no-resolve'] === true}
                                      onChange={(_, checked) =>
                                        updateMatcher(groupIndex, matcherIndex, {
                                          'no-resolve': checked,
                                        })
                                      }
                                    />
                                  }
                                  label="no-resolve"
                                />
                              </Stack>
                            </Box>
                          ))}

                          <Button
                            variant="text"
                            startIcon={<AddRounded />}
                            onClick={() =>
                              updateGroup(groupIndex, {
                                matchers: [...group.matchers, makeMatcher()],
                              })
                            }
                          >
                            添加匹配项
                          </Button>

                          <Divider />
                          <Stack direction="row" justifyContent="space-between">
                            <Stack direction="row">
                              <IconButton
                                disabled={groupIndex === 0}
                                onClick={() => moveGroup(groupIndex, -1)}
                              >
                                <ArrowUpwardRounded />
                              </IconButton>
                              <IconButton
                                disabled={groupIndex === config.groups.length - 1}
                                onClick={() => moveGroup(groupIndex, 1)}
                              >
                                <ArrowDownwardRounded />
                              </IconButton>
                            </Stack>
                            <Button
                              color="error"
                              startIcon={<DeleteOutlineRounded />}
                              onClick={() =>
                                setConfig((previous) => ({
                                  ...previous,
                                  groups: previous.groups.filter(
                                    (_, itemIndex) => itemIndex !== groupIndex,
                                  ),
                                }))
                              }
                            >
                              删除分流组
                            </Button>
                          </Stack>
                        </Stack>
                      </AccordionDetails>
                    </Accordion>
                  ))
                )}
              </Box>
            </Stack>
          )}
        </Box>
      </Dialog>
    </>
  )
}

export default DiversionManager
