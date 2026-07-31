import {
  AddRounded,
  CloseRounded,
  SaveRounded,
  SettingsRounded,
  TuneRounded,
  ViewListRounded,
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
import { useCallback, useMemo, useState } from 'react'

import { readProfileFile, saveProfileFile } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

import GroupCreateDialog from './group-create-dialog'
import GroupEditor from './group-editor'
import {
  defaultConfig,
  type DiversionConfig,
  type DiversionGroup,
  type UnknownRecord,
} from './model'
import {
  BUILTIN_KEY,
  normalizeBuiltinGroups,
  serializeBuiltinGroups,
  type BuiltinGroup,
  withBuiltinAction,
} from './presets'
import { parseDiversionProfile, serializeDiversionProfile } from './serializer'
import SettingsPanel from './settings-panel'
import SimplePanel from './simple-panel'

export const DiversionManager = () => {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [mergeConfig, setMergeConfig] = useState<UnknownRecord>({})
  const [config, setConfig] = useState<DiversionConfig>(defaultConfig)
  const [builtinGroups, setBuiltinGroups] = useState<BuiltinGroup[]>([])

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

  const updateConfig = (patch: Partial<DiversionConfig>) => {
    setConfig((previous) => ({ ...previous, ...patch }))
  }

  const updateGroup = (index: number, patch: Partial<DiversionGroup>) => {
    if (index < 0) return
    setConfig((previous) => ({
      ...previous,
      groups: previous.groups.map((group, currentIndex) =>
        currentIndex === index ? { ...group, ...patch } : group,
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

  const deleteGroup = (index: number) => {
    setConfig((previous) => ({
      ...previous,
      groups: previous.groups.filter(
        (_, currentIndex) => currentIndex !== index,
      ),
    }))
  }

  const appendGroup = (group: DiversionGroup) => {
    setConfig((previous) => ({
      ...previous,
      enabled: true,
      groups: [...previous.groups, group],
    }))
  }

  const save = useCallback(async () => {
    setSaving(true)
    try {
      const mergeWithBuiltins: UnknownRecord = {
        ...mergeConfig,
        [BUILTIN_KEY]: serializeBuiltinGroups(builtinGroups),
      }
      const serialized = serializeDiversionProfile(mergeWithBuiltins, config)
      const valid = await saveProfileFile('Merge', serialized.content)
      if (!valid) throw new Error('Mihomo 配置校验未通过，原配置已恢复')

      setMergeConfig(serialized.mergeConfig)
      showNotice.success('分流配置已保存并立即应用')
      setOpen(false)
    } catch (error) {
      showNotice.error(error)
    } finally {
      setSaving(false)
    }
  }, [builtinGroups, config, mergeConfig])

  const advancedMode = config['ui-mode'] === 'advanced'

  return (
    <>
      <Tooltip title="像 Karing 一样按用途选择分流动作">
        <Button
          size="small"
          variant="outlined"
          startIcon={<TuneRounded />}
          onClick={openManager}
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
            >
              <CloseRounded />
            </IconButton>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="h6">
                {advancedMode ? '高级分流编辑' : '分流规则'}
              </Typography>
              <Typography
                variant="caption"
                sx={{ color: 'text.secondary', display: 'block' }}
                noWrap
              >
                {advancedMode
                  ? '编辑规则内容、顺序和出口选择'
                  : `已启用 ${enabledGroupCount} 个规则组，点击规则即可选择出口`}
              </Typography>
            </Box>
            <Button
              startIcon={
                advancedMode ? <ViewListRounded /> : <SettingsRounded />
              }
              onClick={() =>
                updateConfig({
                  'ui-mode': advancedMode ? 'simple' : 'advanced',
                })
              }
              disabled={loading || saving}
            >
              {advancedMode ? '简单模式' : '高级编辑'}
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

        <Box sx={{ maxWidth: 1100, width: '100%', mx: 'auto', p: 2 }}>
          {loading ? (
            <Typography sx={{ color: 'text.secondary' }}>
              正在读取全局 Merge 配置…
            </Typography>
          ) : advancedMode ? (
            <Stack spacing={2}>
              <Alert severity="warning">
                高级编辑会直接改变最终 Mihomo
                规则。普通使用只需返回“简单模式”，点击规则选择出口。
              </Alert>
              <SettingsPanel config={config} onChange={updateConfig} />

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
                      自定义分流组
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{ color: 'text.secondary' }}
                    >
                      列表顺序就是最终 Mihomo 规则顺序，越靠上优先级越高。
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
                  existingGroups={config.groups}
                  onClose={() => setCreateDialogOpen(false)}
                  onCreate={appendGroup}
                />

                {config.groups.length === 0 ? (
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
                    <Typography sx={{ color: 'text.secondary' }}>
                      还没有自定义分流组，点击“新建分流组”选择空白组或常用模板。
                    </Typography>
                  </Box>
                ) : (
                  <Stack spacing={1}>
                    {config.groups.map((group, index) => (
                      <GroupEditor
                        key={group.id}
                        group={group}
                        index={index}
                        total={config.groups.length}
                        onChange={(patch) => updateGroup(index, patch)}
                        onMove={(direction) => moveGroup(index, direction)}
                        onDelete={() => deleteGroup(index)}
                      />
                    ))}
                  </Stack>
                )}
              </Box>
            </Stack>
          ) : (
            <SimplePanel
              config={config}
              builtinGroups={builtinGroups}
              onConfigChange={updateConfig}
              onBuiltinGroupsChange={setBuiltinGroups}
              onGroupChange={updateGroup}
              onOpenAdvanced={() => updateConfig({ 'ui-mode': 'advanced' })}
            />
          )}
        </Box>
      </Dialog>
    </>
  )
}

export default DiversionManager
