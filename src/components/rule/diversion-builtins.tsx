import {
  AddRounded,
  CloseRounded,
  DeleteOutlineRounded,
  PlaylistAddRounded,
  SaveRounded,
} from '@mui/icons-material'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AppBar,
  Box,
  Button,
  Dialog,
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

const BUILTIN_KEY = 'x-karing-diversion-builtins'

type Action = 'current' | 'auto-select' | 'direct' | 'reject' | 'none'
type UnknownRecord = Record<string, unknown>

interface BuiltinGroup {
  id: string
  name: string
  enabled: boolean
  action: Action
  rules: string[]
}

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const PRESETS: BuiltinGroup[] = [
  {
    id: 'builtin-cn-direct',
    name: '中国大陆直连',
    enabled: false,
    action: 'direct',
    rules: ['geosite:cn', 'geoip:cn'],
  },
  {
    id: 'builtin-ir-direct',
    name: '伊朗直连',
    enabled: false,
    action: 'direct',
    rules: ['geosite:ir', 'geoip:ir'],
  },
  {
    id: 'builtin-ads-reject',
    name: '广告拦截',
    enabled: false,
    action: 'reject',
    rules: ['geosite:category-ads-all'],
  },
  {
    id: 'builtin-non-cn-proxy',
    name: '非中国站点代理',
    enabled: false,
    action: 'current',
    rules: ['geosite:geolocation-!cn'],
  },
]

const normalizeAction = (value: unknown): Action => {
  switch (value) {
    case 'auto-select':
    case 'direct':
    case 'reject':
    case 'none':
      return value
    default:
      return 'current'
  }
}

const normalizeGroups = (value: unknown): BuiltinGroup[] => {
  if (!Array.isArray(value))
    return PRESETS.map((item) => ({ ...item, rules: [...item.rules] }))

  return value.filter(isRecord).map((group, index) => ({
    id:
      typeof group.id === 'string' && group.id ? group.id : crypto.randomUUID(),
    name:
      typeof group.name === 'string' && group.name.trim()
        ? group.name
        : `内置规则组 ${index + 1}`,
    enabled: group.enabled !== false,
    action: normalizeAction(group.action),
    rules: Array.isArray(group.matchers)
      ? group.matchers
          .filter(isRecord)
          .map((matcher) =>
            typeof matcher.value === 'string' ? matcher.value.trim() : '',
          )
          .filter(Boolean)
      : [],
  }))
}

const serializeGroups = (groups: BuiltinGroup[]) =>
  groups.map((group) => ({
    name: group.name.trim(),
    enabled: group.enabled,
    logic: 'or',
    action: group.action,
    matchers: group.rules
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => ({ enabled: true, type: 'RULE-SET-BUILDIN', value })),
  }))

export const DiversionBuiltins = () => {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mergeConfig, setMergeConfig] = useState<UnknownRecord>({})
  const [groups, setGroups] = useState<BuiltinGroup[]>([])

  const enabledCount = useMemo(
    () =>
      groups.filter((group) => group.enabled && group.action !== 'none').length,
    [groups],
  )

  const openEditor = useCallback(async () => {
    setOpen(true)
    setLoading(true)
    try {
      const content = await readProfileFile('Merge')
      const parsed = content.trim() ? load(content) : {}
      const merge = isRecord(parsed) ? parsed : {}
      setMergeConfig(merge)
      setGroups(normalizeGroups(merge[BUILTIN_KEY]))
    } catch (error) {
      showNotice.error(error)
    } finally {
      setLoading(false)
    }
  }, [])

  const updateGroup = (index: number, patch: Partial<BuiltinGroup>) => {
    setGroups((previous) =>
      previous.map((group, itemIndex) =>
        itemIndex === index ? { ...group, ...patch } : group,
      ),
    )
  }

  const addGroup = () => {
    setGroups((previous) => [
      ...previous,
      {
        id: crypto.randomUUID(),
        name: `内置规则组 ${previous.length + 1}`,
        enabled: true,
        action: 'current',
        rules: ['geosite:'],
      },
    ])
  }

  const save = useCallback(async () => {
    const invalid = groups.find(
      (group) =>
        group.enabled &&
        group.action !== 'none' &&
        (!group.name.trim() ||
          !group.rules.some((rule) =>
            /^(geosite|geoip|acl):.+/i.test(rule.trim()),
          )),
    )
    if (invalid) {
      showNotice.error(
        `规则组“${invalid.name || '未命名'}”缺少有效的 geosite/geoip/acl 规则`,
      )
      return
    }

    setSaving(true)
    try {
      const nextMerge = {
        ...mergeConfig,
        [BUILTIN_KEY]: serializeGroups(groups),
      }
      const content = dump(nextMerge, {
        noRefs: true,
        lineWidth: 120,
        noCompatMode: true,
      })
      const valid = await saveProfileFile('Merge', content)
      if (!valid) throw new Error('Mihomo 配置校验未通过，原配置已恢复')
      setMergeConfig(nextMerge)
      showNotice.success('内置分流规则已保存并应用')
      setOpen(false)
    } catch (error) {
      showNotice.error(error)
    } finally {
      setSaving(false)
    }
  }, [groups, mergeConfig])

  return (
    <>
      <Tooltip title="管理 GeoSite、GeoIP 和 ACL 内置规则集">
        <Button
          size="small"
          variant="outlined"
          startIcon={<PlaylistAddRounded />}
          onClick={openEditor}
        >
          内置规则
        </Button>
      </Tooltip>

      <Dialog fullScreen open={open} onClose={() => !saving && setOpen(false)}>
        <AppBar position="sticky" color="default" elevation={1}>
          <Toolbar sx={{ gap: 1 }}>
            <IconButton
              edge="start"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              <CloseRounded />
            </IconButton>
            <Box sx={{ flex: 1 }}>
              <Typography variant="h6">内置规则集</Typography>
              <Typography variant="caption" color="text.secondary">
                已启用 {enabledCount} 个规则组
              </Typography>
            </Box>
            <Button
              startIcon={<AddRounded />}
              onClick={addGroup}
              disabled={loading || saving}
            >
              新增
            </Button>
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

        <Box sx={{ width: '100%', maxWidth: 960, mx: 'auto', p: 2 }}>
          <Stack spacing={2}>
            <Alert severity="info">
              每行填写一个 geosite:name、geoip:name 或 acl:name。ACL
              需要现有同名
              rule-provider；所有预设默认关闭，避免首次保存改变现有路由。
            </Alert>

            {loading ? (
              <Typography color="text.secondary">
                正在读取全局 Merge 配置…
              </Typography>
            ) : (
              groups.map((group, index) => (
                <Accordion key={group.id} defaultExpanded={index === 0}>
                  <AccordionSummary>
                    <Stack
                      direction="row"
                      spacing={1.5}
                      alignItems="center"
                      sx={{ width: '100%' }}
                    >
                      <Switch
                        checked={group.enabled}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(_, checked) =>
                          updateGroup(index, { enabled: checked })
                        }
                      />
                      <Typography sx={{ flex: 1 }}>{group.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {group.rules.length} 项
                      </Typography>
                    </Stack>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Stack spacing={2}>
                      <TextField
                        label="规则组名称"
                        value={group.name}
                        onChange={(event) =>
                          updateGroup(index, { name: event.target.value })
                        }
                      />
                      <FormControl fullWidth>
                        <InputLabel>动作</InputLabel>
                        <Select
                          label="动作"
                          value={group.action}
                          onChange={(event) =>
                            updateGroup(index, {
                              action: event.target.value as Action,
                            })
                          }
                        >
                          <MenuItem value="current">当前选择</MenuItem>
                          <MenuItem value="auto-select">自动选择</MenuItem>
                          <MenuItem value="direct">直连</MenuItem>
                          <MenuItem value="reject">拦截</MenuItem>
                          <MenuItem value="none">无</MenuItem>
                        </Select>
                      </FormControl>
                      <TextField
                        multiline
                        minRows={5}
                        label="内置规则（每行一项）"
                        value={group.rules.join('\n')}
                        onChange={(event) =>
                          updateGroup(index, {
                            rules: event.target.value.split(/\r?\n/),
                          })
                        }
                        placeholder={'geosite:cn\ngeoip:cn\nacl:BanAD'}
                      />
                      <FormControlLabel
                        control={
                          <Switch
                            checked={group.enabled}
                            onChange={(_, checked) =>
                              updateGroup(index, { enabled: checked })
                            }
                          />
                        }
                        label="启用此规则组"
                      />
                      <Button
                        color="error"
                        startIcon={<DeleteOutlineRounded />}
                        onClick={() =>
                          setGroups((previous) =>
                            previous.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          )
                        }
                      >
                        删除规则组
                      </Button>
                    </Stack>
                  </AccordionDetails>
                </Accordion>
              ))
            )}
          </Stack>
        </Box>
      </Dialog>
    </>
  )
}

export default DiversionBuiltins
