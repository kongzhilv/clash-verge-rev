import { CloseRounded, SearchRounded } from '@mui/icons-material'
import {
  Alert,
  AppBar,
  Box,
  Button,
  Chip,
  Dialog,
  IconButton,
  Paper,
  Stack,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material'
import { load } from 'js-yaml'
import { useCallback, useMemo, useState } from 'react'

import { readProfileFile } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

const CONFIG_KEY = 'x-karing-diversion'
const BUILTIN_KEY = 'x-karing-diversion-builtins'

type UnknownRecord = Record<string, unknown>

interface DetectionHit {
  group: string
  action: string
  matcherType: string
  matcherValue: string
}

interface DeferredRule extends DetectionHit {}

interface DetectionResult {
  hits: DetectionHit[]
  deferred: DeferredRule[]
}

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizeHost = (value: string) => {
  const input = value.trim()
  if (!input) return ''

  try {
    return new URL(input.includes('://') ? input : `https://${input}`).hostname
      .replace(/\.$/, '')
      .toLowerCase()
  } catch {
    return input.split('/')[0].replace(/\.$/, '').toLowerCase()
  }
}

const actionLabel = (value: unknown) => {
  const action = typeof value === 'string' ? value.toLowerCase() : 'current'
  switch (action) {
    case 'none':
      return '无'
    case 'auto':
    case 'auto-select':
      return '自动选择'
    case 'direct':
      return '直连'
    case 'reject':
      return '拦截'
    case 'reject-drop':
      return '静默拦截'
    case 'policy':
      return '指定策略组'
    default:
      return '当前选择'
  }
}

const matchDomain = (host: string, matcher: UnknownRecord): boolean | null => {
  if (matcher.enabled === false) return false

  const type = typeof matcher.type === 'string' ? matcher.type.toUpperCase() : ''
  const rawValue = typeof matcher.value === 'string' ? matcher.value.trim() : ''
  if (!rawValue) return false

  const value = rawValue.replace(/^\./, '').toLowerCase()
  switch (type) {
    case 'DOMAIN':
      return host === value
    case 'DOMAIN-SUFFIX':
      return host === value || host.endsWith(`.${value}`)
    case 'DOMAIN-KEYWORD':
      return host.includes(value)
    case 'DOMAIN-REGEX':
      try {
        return new RegExp(rawValue).test(host)
      } catch {
        return false
      }
    default:
      return null
  }
}

const matcherSummary = (group: UnknownRecord, matcher: UnknownRecord): DetectionHit => ({
  group:
    typeof group.name === 'string' && group.name.trim()
      ? group.name
      : '未命名分流组',
  action: actionLabel(group.action),
  matcherType: typeof matcher.type === 'string' ? matcher.type : 'UNKNOWN',
  matcherValue: typeof matcher.value === 'string' ? matcher.value : '',
})

const detect = (config: UnknownRecord, host: string): DetectionResult => {
  if (config.enabled !== true || !Array.isArray(config.groups)) {
    return { hits: [], deferred: [] }
  }

  const hits: DetectionHit[] = []
  const deferred: DeferredRule[] = []

  for (const rawGroup of config.groups) {
    if (!isRecord(rawGroup) || rawGroup.enabled === false || rawGroup.action === 'none') continue
    if (!Array.isArray(rawGroup.matchers)) continue

    const evaluations = rawGroup.matchers
      .filter(isRecord)
      .filter((matcher) => matcher.enabled !== false)
      .map((matcher) => ({ matcher, matched: matchDomain(host, matcher) }))
    const supported = evaluations.filter((item) => item.matched !== null)
    const unresolved = evaluations.filter((item) => item.matched === null)

    const isAnd = rawGroup.logic === 'and'
    const groupMatched = isAnd
      ? evaluations.length > 0 &&
        supported.length === evaluations.length &&
        supported.every((item) => item.matched)
      : supported.some((item) => item.matched)

    if (groupMatched) {
      const matched = supported.find((item) => item.matched) ?? supported[0]
      if (matched) hits.push(matcherSummary(rawGroup, matched.matcher))
      continue
    }

    for (const item of unresolved) {
      const value =
        typeof item.matcher.value === 'string' ? item.matcher.value.trim() : ''
      if (value) deferred.push(matcherSummary(rawGroup, item.matcher))
    }
  }

  return { hits, deferred }
}

const mergeDetectorConfig = (merge: UnknownRecord): UnknownRecord => {
  const primary = isRecord(merge[CONFIG_KEY]) ? merge[CONFIG_KEY] : {}
  const primaryGroups = Array.isArray(primary.groups) ? primary.groups : []
  const builtinGroups = Array.isArray(merge[BUILTIN_KEY]) ? merge[BUILTIN_KEY] : []
  const hasActiveBuiltins = builtinGroups.some(
    (group) =>
      isRecord(group) &&
      group.enabled !== false &&
      group.action !== 'none' &&
      Array.isArray(group.matchers),
  )

  return {
    ...primary,
    enabled: primary.enabled === true || hasActiveBuiltins,
    groups: [...primaryGroups, ...builtinGroups],
  }
}

export const DiversionDetector = () => {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [input, setInput] = useState('')
  const [config, setConfig] = useState<UnknownRecord>({})

  const host = useMemo(() => normalizeHost(input), [input])
  const result = useMemo(
    () => (host ? detect(config, host) : { hits: [], deferred: [] }),
    [config, host],
  )

  const openDetector = useCallback(async () => {
    setOpen(true)
    setLoading(true)
    try {
      const content = await readProfileFile('Merge')
      const parsed = content.trim() ? load(content) : {}
      const merge = isRecord(parsed) ? parsed : {}
      setConfig(mergeDetectorConfig(merge))
    } catch (error) {
      showNotice.error(error)
    } finally {
      setLoading(false)
    }
  }, [])

  return (
    <>
      <Tooltip title="检测域名命中的自定义和内置分流组">
        <Button
          size="small"
          variant="outlined"
          startIcon={<SearchRounded />}
          onClick={openDetector}
        >
          分流检测
        </Button>
      </Tooltip>

      <Dialog fullScreen open={open} onClose={() => setOpen(false)}>
        <AppBar position="sticky" color="default" elevation={1}>
          <Toolbar sx={{ gap: 1 }}>
            <IconButton edge="start" onClick={() => setOpen(false)}>
              <CloseRounded />
            </IconButton>
            <Box sx={{ flex: 1 }}>
              <Typography variant="h6">分流规则检测</Typography>
              <Typography variant="caption" color="text.secondary">
                仅按域名检测；IP、端口、进程和规则集内容需要 Mihomo 核心判定
              </Typography>
            </Box>
          </Toolbar>
        </AppBar>

        <Box sx={{ width: '100%', maxWidth: 900, mx: 'auto', p: 2 }}>
          <Stack spacing={2}>
            <Alert severity="info">
              与 Karing 一样，这里是域名规则预览；真实连接还会受 IP、端口、进程、规则集下载状态和运行时规则影响。
            </Alert>
            <TextField
              autoFocus
              fullWidth
              label="域名或网址"
              placeholder="openai.com 或 https://chatgpt.com/"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={loading}
            />

            {loading ? (
              <Typography color="text.secondary">正在读取全局 Merge 配置…</Typography>
            ) : !host ? (
              <Typography color="text.secondary">输入域名后开始检测。</Typography>
            ) : config.enabled !== true ? (
              <Alert severity="warning">Karing 风格分流当前未启用。</Alert>
            ) : (
              <Stack spacing={2}>
                {result.hits.length ? (
                  <Stack spacing={1.5}>
                    {result.hits.map((hit, index) => (
                      <Paper key={`${hit.group}-${hit.matcherType}-${index}`} variant="outlined" sx={{ p: 2 }}>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                          <Chip
                            size="small"
                            color={index === 0 ? 'primary' : 'default'}
                            label={index === 0 ? '首个命中' : `后续命中 ${index + 1}`}
                          />
                          <Typography fontWeight={600}>{hit.group}</Typography>
                        </Stack>
                        <Typography sx={{ mt: 1 }}>
                          {hit.matcherType},{hit.matcherValue}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          动作：{hit.action}
                        </Typography>
                      </Paper>
                    ))}
                  </Stack>
                ) : (
                  <Alert severity="warning">没有命中可在本地判断的域名规则。</Alert>
                )}

                {result.deferred.length ? (
                  <Paper variant="outlined" sx={{ p: 2 }}>
                    <Typography fontWeight={600}>需 Mihomo 核心判定</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      以下 GeoSite、GeoIP、Rule Set、进程或端口规则已启用，但本地域名预览不会把它们伪报为命中。
                    </Typography>
                    <Stack spacing={0.75}>
                      {result.deferred.map((item, index) => (
                        <Typography
                          key={`${item.group}-${item.matcherType}-${item.matcherValue}-${index}`}
                          variant="body2"
                        >
                          {item.group}：{item.matcherType},{item.matcherValue}（{item.action}）
                        </Typography>
                      ))}
                    </Stack>
                  </Paper>
                ) : null}
              </Stack>
            )}
          </Stack>
        </Box>
      </Dialog>
    </>
  )
}

export default DiversionDetector
