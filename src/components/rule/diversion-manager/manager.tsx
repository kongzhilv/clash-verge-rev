import {
  AddRounded,
  CloseRounded,
  SaveRounded,
  TuneRounded,
} from '@mui/icons-material'
import {
  Alert,
  AppBar,
  Box,
  Button,
  Dialog,
  IconButton,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { notifyDiversionUpdated } from '@/hooks/use-diversion-profile'
import { readProfileFile, saveProfileFile } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

import GroupCreateDialog from './group-create-dialog'
import GroupEditor from './group-editor'
import {
  defaultConfig,
  syncProjectGroups,
  type DiversionConfig,
  type DiversionGroup,
  type UnknownRecord,
} from './model'
import {
  BUILTIN_KEY,
  normalizeBuiltinGroups,
  serializeBuiltinGroups,
  type BuiltinGroup,
  validateBuiltinGroups,
  withBuiltinAction,
} from './presets'
import ProjectPanel from './project-panel'
import { parseDiversionProfile, serializeDiversionProfile } from './serializer'
import SettingsPanel from './settings-panel'

interface DiversionManagerProps {
  initialOpen?: boolean
  focusProjectId?: string | null
}

export const DiversionManager = ({
  initialOpen = false,
  focusProjectId,
}: DiversionManagerProps) => {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [mergeConfig, setMergeConfig] = useState<UnknownRecord>({})
  const [config, setConfig] = useState<DiversionConfig>(defaultConfig)
  const [builtinGroups, setBuiltinGroups] = useState<BuiltinGroup[]>([])
  const lastAutoOpenKey = useRef<string | null>(null)

  const manualGroups = useMemo(
    () => config.groups.filter((group) => !group['project-id']),
    [config.groups],
  )

  const enabledGroupCount = useMemo(
    () =>
      config.groups.filter((group) => group.enabled && group.action !== 'none')
        .length +
      builtinGroups.filter((group) => group.enabled && group.action !== 'none')
        .length,
    [builtinGroups, config.groups],
  )

  const openManager = useCallback(async () => {
    setOpen(true)
    setLoading(true)
    try {
      const content = await readProfileFile('Merge')
      const parsed = parseDiversionProfile(content)
      const normalizedBuiltins = normalizeBuiltinGroups(
        parsed.mergeConfig[BUILTIN_KEY],
      )
      const region = parsed.config['auto-country-rules']
        ? parsed.config['country-or-region']
        : ''
      const deduplicatedBuiltins = region
        ? normalizedBuiltins.map((group) =>
            group.presetId === `${region}-direct`
              ? withBuiltinAction(group, 'none')
              : group,
          )
        : normalizedBuiltins

      setMergeConfig(parsed.mergeConfig)
      setConfig(parsed.config)
      setBuiltinGroups(deduplicatedBuiltins)
    } catch (error) {
      showNotice.error(error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const autoOpenKey = initialOpen ? focusProjectId ?? 'projects' : null
    if (!autoOpenKey || lastAutoOpenKey.current === autoOpenKey) return
    lastAutoOpenKey.current = autoOpenKey
    void openManager()
  }, [focusProjectId, initialOpen, openManager])

  const updateConfig = (patch: Partial<DiversionConfig>) => {
    setConfig((previous) => syncProjectGroups({ ...previous, ...patch }))
  }

  const updateGroup = (groupId: string, patch: Partial<DiversionGroup>) => {
    setConfig((previous) =>
      syncProjectGroups({
        ...previous,
        groups: previous.groups.map((group) =>
          group.id === groupId ? { ...group, ...patch } : group,
        ),
      }),
    )
  }

  const moveGroup = (groupId: string, direction: -1 | 1) => {
    setConfig((previous) => {
      const manual = previous.groups.filter((group) => !group['project-id'])
      const index = manual.findIndex((group) => group.id === groupId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= manual.length) return previous

      const reordered = [...manual]
      ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
      const managed = previous.groups.filter((group) => group['project-id'])
      return syncProjectGroups({ ...previous, groups: [...managed, ...reordered] })
    })
  }

  const deleteGroup = (groupId: string) => {
    setConfig((previous) =>
      syncProjectGroups({
        ...previous,
        groups: previous.groups.filter((group) => group.id !== groupId),
      }),
    )
  }

  const appendGroup = (group: DiversionGroup) => {
    setConfig((previous) =>
      syncProjectGroups({
        ...previous,
        enabled: true,
        groups: [...previous.groups, group],
      }),
    )
  }

  const save = useCallback(async () => {
    setSaving(true)
    try {
      const builtinError = validateBuiltinGroups(builtinGroups)
      if (builtinError) throw new Error(builtinError)

      const mergeWithBuiltins: UnknownRecord = {
        ...mergeConfig,
        [BUILTIN_KEY]: serializeBuiltinGroups(builtinGroups),
      }
      const serialized = serializeDiversionProfile(mergeWithBuiltins, config)
      const valid = await saveProfileFile('Merge', serialized.content)
      if (!valid) throw new Error('Mihomo 配置校验未通过，原配置已恢复')

      setMergeConfig(serialized.mergeConfig)
      setConfig(serialized.config)
      notifyDiversionUpdated(serialized.config)
      showNotice.success('分流、程序项目与代理组关系已保存并立即应用')
      setOpen(false)
    } catch (error) {
      showNotice.error(error)
    } finally {
      setSaving(false)
    }
  }, [builtinGroups, config, mergeConfig])

  return (
    <>
      <Tooltip title="统一管理规则、程序项目、连接识别和出口代理组">
        <Button
          size="small"
          variant="outlined"
          startIcon={<TuneRounded />}
          onClick={() => void openManager()}
        >
          分流设置
        </Button>
      </Tooltip>
      <Dialog fullScreen open={open} onClose={() => !saving && setOpen(false)}>
        <AppBar position="sticky" color="default" elevation={1}>
          <Toolbar sx={{ gap: 1 }}>
            <IconButton
              edge="start"
              onClick={() => setOpen(false)}
              disabled={saving}
              aria-label="关闭分流设置"
            >
              <CloseRounded />
            </IconButton>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="h6">完整分流管理</Typography>
              <Typography
                variant="caption"
                sx={{ color: 'text.secondary', display: 'block' }}
                noWrap
              >
                {`程序项目 ${config.projects.length} 个 · 已启用规则组 ${enabledGroupCount} 个`}
              </Typography>
            </Box>
            <Button
              variant="contained"
              startIcon={<SaveRounded />}
              onClick={() => void save()}
              disabled={loading || saving}
            >
              {saving ? '正在校验…' : '保存并应用'}
            </Button>
          </Toolbar>
        </AppBar>

        <Box sx={{ maxWidth: 1180, width: '100%', mx: 'auto', p: 2 }}>
          {loading ? (
            <Typography sx={{ color: 'text.secondary' }}>
              正在读取全局 Merge 配置…
            </Typography>
          ) : (
            <Stack spacing={2.5}>
              <Alert severity="info">
                已取消简单模式。这里直接显示完整规则、程序项目、优先级和出口；程序项目生成的规则组会与连接页和代理组页共享同一关系。
              </Alert>

              <SettingsPanel config={config} onChange={updateConfig} />

              <ProjectPanel
                config={config}
                focusProjectId={focusProjectId}
                onChange={updateConfig}
              />

              <Box>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1}
                  sx={{
                    alignItems: { sm: 'center' },
                    justifyContent: 'space-between',
                    mb: 1,
                  }}
                >
                  <Box>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                      手动分流规则组
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      程序项目的托管规则组在上方编辑；这里保留其他自定义规则。列表越靠上优先级越高。
                    </Typography>
                  </Box>
                  <Button
                    startIcon={<AddRounded />}
                    onClick={() => setCreateDialogOpen(true)}
                  >
                    新建分流组
                  </Button>
                </Stack>

                <GroupCreateDialog
                  open={createDialogOpen}
                  existingGroups={manualGroups}
                  onClose={() => setCreateDialogOpen(false)}
                  onCreate={appendGroup}
                />

                {manualGroups.length === 0 ? (
                  <Box
                    sx={{
                      p: 4,
                      textAlign: 'center',
                      border: 1,
                      borderStyle: 'dashed',
                      borderColor: 'divider',
                      borderRadius: 2,
                    }}
                  >
                    <Typography color="text.secondary">
                      没有额外的手动规则组。可直接使用上方程序项目，或在此创建任意 Mihomo 分流规则。
                    </Typography>
                  </Box>
                ) : (
                  <Stack spacing={1}>
                    {manualGroups.map((group, index) => (
                      <GroupEditor
                        key={group.id}
                        group={group}
                        index={index}
                        total={manualGroups.length}
                        onChange={(patch) => updateGroup(group.id, patch)}
                        onMove={(direction) => moveGroup(group.id, direction)}
                        onDelete={() => deleteGroup(group.id)}
                      />
                    ))}
                  </Stack>
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
