import {
  AddRounded,
  CloseRounded,
  SaveRounded,
  TuneRounded,
} from '@mui/icons-material'
import {
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

import GroupEditor from './group-editor'
import {
  defaultConfig,
  makeGroup,
  type DiversionConfig,
  type DiversionGroup,
  type UnknownRecord,
} from './model'
import { parseDiversionProfile, serializeDiversionProfile } from './serializer'
import SettingsPanel from './settings-panel'

export const DiversionManager = () => {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mergeConfig, setMergeConfig] = useState<UnknownRecord>({})
  const [config, setConfig] = useState<DiversionConfig>(defaultConfig)

  const enabledGroupCount = useMemo(
    () =>
      config.groups.filter((group) => group.enabled && group.action !== 'none')
        .length,
    [config.groups],
  )

  const openManager = useCallback(async () => {
    setOpen(true)
    setLoading(true)
    try {
      const content = await readProfileFile('Merge')
      const parsed = parseDiversionProfile(content)
      setMergeConfig(parsed.mergeConfig)
      setConfig(parsed.config)
    } catch (error) {
      showNotice.error(error)
    } finally {
      setLoading(false)
    }
  }, [])

  const updateGroup = (index: number, patch: Partial<DiversionGroup>) => {
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

  const save = useCallback(async () => {
    setSaving(true)
    try {
      const serialized = serializeDiversionProfile(mergeConfig, config)
      const valid = await saveProfileFile('Merge', serialized.content)
      if (!valid) throw new Error('Mihomo 配置校验未通过，原配置已恢复')

      setMergeConfig(serialized.mergeConfig)
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
            <IconButton
              edge="start"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
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
            <Typography color="text.secondary">
              正在读取全局 Merge 配置…
            </Typography>
          ) : (
            <Stack spacing={2}>
              <SettingsPanel
                config={config}
                onChange={(patch) =>
                  setConfig((previous) => ({ ...previous, ...patch }))
                }
              />

              <Box>
                <Stack
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  sx={{ mb: 1 }}
                >
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
                        groups: [
                          ...previous.groups,
                          makeGroup(previous.groups.length),
                        ],
                      }))
                    }
                  >
                    新建分流组
                  </Button>
                </Stack>

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
                    <Typography color="text.secondary">
                      还没有自定义分流组
                    </Typography>
                  </Box>
                ) : (
                  <Stack spacing={1}>
                    {config.groups.map((group, index) => (
                      <GroupEditor
                        key={`${group.name}-${index}`}
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
          )}
        </Box>
      </Dialog>
    </>
  )
}

export default DiversionManager
