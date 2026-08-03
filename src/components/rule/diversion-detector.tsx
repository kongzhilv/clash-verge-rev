import { CloseRounded, SearchRounded } from '@mui/icons-material'
import {
  Alert,
  AppBar,
  Box,
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
  id: string
  group: string
  action: string
  matcherType: string
  matcherValue: string
}

interface DetectionResult {
  hits: DetectionHit[]
  deferred: DetectionHit[]
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

  const type =
    typeof matcher.type === 'string' ? matcher.type.toUpperCase() : ''
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

const matcherSummary = (
  group: UnknownRecord,
  matcher: UnknownRecord,
  groupIndex: number,
  matcherIndex: number,
): DetectionHit => {
  const matcherType =
    typeof matcher.type === 'string' ? matcher.type : 'UNKNOWN'
  const matcherValue = typeof matcher.value === 'string' ? matcher.value : ''

  return {
    id: `${groupIndex}:${matcherIndex}:${matcherType}:${matcherValue}`,
    group:
      typeof group.name === 'string' && group.name.trim()
        ? group.name
        : '未命名分流组',
    action: actionLabel(group.action),
    matcherType,
    matcherValue,
  }
}

const detect = (config: UnknownRecord, host: string): DetectionResult => {
  if (config.enabled !== true || !Array.isArray(config.groups)) {
    return { hits: [], deferred: [] }
  }

  const hits: DetectionHit[] = []
  const deferred: DetectionHit[] = []

  for (const [groupIndex, rawGroup] of config.groups.entries()) {
    if (
      !isRecord(rawGroup) ||
      rawGroup.enabled === false ||
      rawGroup.action === 'none'
    )
      continue
    if (!Array.isArray(rawGroup.matchers)) continue

    const evaluations = rawGroup.matchers
      .filter(isRecord)
      .filter((matcher) => matcher.enabled !== false)
      .map((matcher, matcherIndex) => ({
        matcher,
        matcherIndex,
        matched: matchDomain(host, matcher),
      }))
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
      if (matched)
        hits.push(
          matcherSummary(
            rawGroup,
            matched.matcher,
            groupIndex,
            matched.matcherIndex,
          ),
        )
      continue
    }

    for (const item of unresolved) {
      const value =
        typeof item.matcher.value === 'string' ? item.matcher.value.trim() : ''
      if (value)
        deferred.push(
          matcherSummary(rawGroup, item.matcher, groupIndex, item.matcherIndex),
        )
    }
  }

  return { hits, deferred }
}

const mergeDetectorConfig = (merge: UnknownRecord): UnknownRecord => {
  const primary = isRecord(merge[CONFIG_KEY]) ? merge[CONFIG_KEY] : {}
  const primaryGroups = Array.isArray(primary.groups) ? primary.groups : []
  const builtinGroups = Array.isArray(merge[BUILTIN_KEY])
    ? merge[BUILTIN_KEY]
    : []
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
      <Tooltip title="测试域名分流">
        <IconButton size="small" onClick={openDetector}>
          <SearchRounded fontSize="small" />
        </IconButton>
      </Tooltip>
      <Dialog fullScreen open={open} onClose={() => setOpen(false)}>
        <AppBar
          position="sticky"
          color="default"
          elevation={0}
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Toolbar sx={{ gap: 1 }}>
            <IconButton edge="start" onClick={() => setOpen(false)}>
              <CloseRounded />
            </IconButton>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              域名测试
            </Typography>
          </Toolbar>
        </AppBar>

        <Box sx={{ width: '100%', maxWidth: 840, mx: 'auto', p: 2 }}>
          <Stack spacing={1.5}>
            <TextField
              autoFocus
              fullWidth
              label="域名或网址"
              placeholder="openai.com"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={loading}
            />

            {loading ? (
              <Typography color="text.secondary">读取配置中…</Typography>
            ) : !host ? null : config.enabled !== true ? (
              <Alert severity="warning">分流当前未启用。</Alert>
            ) : (
              <Stack spacing={1.5}>
                {result.hits.length ? (
                  <Stack spacing={0.75}>
                    {result.hits.map((hit, index) => (
                      <Paper
                        key={hit.id}
                        variant="outlined"
                        sx={{ px: 1.5, py: 1.25, borderRadius: 2 }}
                      >
                        <Stack
                          direction="row"
                          spacing={1}
                          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                        >
                          <Chip
                            size="small"
                            color={index === 0 ? 'primary' : 'default'}
                            label={index === 0 ? '首个命中' : `候选 ${index + 1}`}
                          />
                          <Typography sx={{ fontWeight: 650 }}>
                            {hit.group}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {`${hit.matcherType} · ${hit.matcherValue} · ${hit.action}`}
                          </Typography>
                        </Stack>
                      </Paper>
                    ))}
                  </Stack>
                ) : (
                  <Alert severity="info">未命中本地可判断的域名规则。</Alert>
                )}

                {result.deferred.length > 0 && (
                  <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                    <Typography sx={{ fontWeight: 650, mb: 0.5 }}>
                      由 Mihomo 继续判断
                    </Typography>
                    <Stack spacing={0.4}>
                      {result.deferred.map((item) => (
                        <Typography
                          key={item.id}
                          variant="body2"
                          color="text.secondary"
                        >
                          {`${item.group} · ${item.matcherType} · ${item.matcherValue}`}
                        </Typography>
                      ))}
                    </Stack>
                  </Paper>
                )}
              </Stack>
            )}
          </Stack>
        </Box>
      </Dialog>
    </>
  )
}

export default DiversionDetector
