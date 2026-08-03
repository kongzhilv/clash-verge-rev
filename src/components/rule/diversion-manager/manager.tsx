import {
  AddRounded,
  AppsRounded,
  CloseRounded,
  RuleRounded,
  SaveRounded,
  SettingsRounded,
  TuneRounded,
} from '@mui/icons-material'
import {
  AppBar,
  Box,
  Button,
  CircularProgress,
  Dialog,
  IconButton,
  Stack,
  Tab,
  Tabs,
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

type ManagerTab = 'projects' | 'rules' | 'settings'

export const DiversionManager = ({
  initialOpen = false,
  focusProjectId,
}: DiversionManagerProps) => {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState<ManagerTab>('projects')
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [mergeConfig, setMergeConfig] = useState<UnknownRecord>({})
  const [config, setConfig] = useState<DiversionConfig>(defaultConfig)
  const [builtinGroups, setBuiltinGroups] = useState<BuiltinGroup[]>([])
  const lastAutoOpenKeyRef = useRef<string | null>(null)

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
    const autoOpenKey = initialOpen ? (focusProjectId ?? 'projects') : null
    if (!autoOpenKey || lastAutoOpenKeyRef.current === autoOpenKey) return
    lastAutoOpenKeyRef.current = autoOpenKey
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
      ;[reordered[index], reordered[target]] = [
        reordered[target],
        reordered[index],
      ]
      const managed = previous.groups.filter((group) => group['project-id'])
      return syncProjectGroups({
        ...previous,
        groups: [...managed, ...reordered],
      })
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
      showNotice.success('分流配置已应用')
      setOpen(false)
    } catch (error) {
      showNotice.error(error)
    } finally {
      setSaving(false)
    }
  }, [builtinGroups, config, mergeConfig])

  return (
    <>
      <Tooltip title="管理程序、规则和出口">
        <Button
          size="small"
          variant="contained"
          startIcon={<TuneRounded />}
          onClick={() => {
            setActiveTab('projects')
            void openManager()
          }}
        >
          分流中心
        </Button>
      </Tooltip>

      <Dialog fullScreen open={open} onClose={() => !saving && setOpen(false)}>
        <AppBar
          position="sticky"
          color="default"
          elevation={0}
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Toolbar sx={{ gap: 1.25, minHeight: 60 }}>
            <IconButton
              edge="start"
              onClick={() => setOpen(false)}
              disabled={saving}
              aria-label="关闭分流中心"
            >
              <CloseRounded />
            </IconButton>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                分流中心
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {`${config.projects.length} 个项目 · ${enabledGroupCount} 个规则组生效`}
              </Typography>
            </Box>
            <Button
              variant="contained"
              startIcon={<SaveRounded />}
              onClick={() => void save()}
              disabled={loading || saving}
            >
              {saving ? '校验中…' : '应用'}
            </Button>
          </Toolbar>

          <Tabs
            value={activeTab}
            onChange={(_, value: ManagerTab) => setActiveTab(value)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ px: 1.5, minHeight: 46 }}
          >
            <Tab
              value="projects"
              icon={<AppsRounded fontSize="small" />}
              iconPosition="start"
              label={`程序与项目 ${config.projects.length}`}
            />
            <Tab
              value="rules"
              icon={<RuleRounded fontSize="small" />}
              iconPosition="start"
              label={`规则 ${manualGroups.length}`}
            />
            <Tab
              value="settings"
              icon={<SettingsRounded fontSize="small" />}
              iconPosition="start"
              label="设置"
            />
          </Tabs>
        </AppBar>

        <Box
          sx={{
            minHeight: '100%',
            bgcolor: 'background.default',
            px: { xs: 1.25, md: 2.5 },
            py: 2,
          }}
        >
          <Box sx={{ maxWidth: 1180, width: '100%', mx: 'auto' }}>
            {loading ? (
              <Box sx={{ display: 'grid', placeItems: 'center', py: 10 }}>
                <CircularProgress size={28} />
              </Box>
            ) : activeTab === 'projects' ? (
              <ProjectPanel
                config={config}
                focusProjectId={focusProjectId}
                onChange={updateConfig}
              />
            ) : activeTab === 'settings' ? (
              <SettingsPanel config={config} onChange={updateConfig} />
            ) : (
              <Box>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1}
                  sx={{
                    alignItems: { sm: 'center' },
                    justifyContent: 'space-between',
                    mb: 1.5,
                  }}
                >
                  <Box>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                      自定义规则
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      越靠上的规则优先级越高。
                    </Typography>
                  </Box>
                  <Button
                    variant="outlined"
                    startIcon={<AddRounded />}
                    onClick={() => setCreateDialogOpen(true)}
                  >
                    新建规则组
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
                      py: 7,
                      textAlign: 'center',
                      border: 1,
                      borderStyle: 'dashed',
                      borderColor: 'divider',
                      borderRadius: 2.5,
                      bgcolor: 'background.paper',
                    }}
                  >
                    <Typography color="text.secondary">
                      暂无额外规则。程序项目会自动生成对应规则。
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
            )}
          </Box>
        </Box>
      </Dialog>
    </>
  )
}

export default DiversionManager
