import {
  AddRounded,
  ExpandMoreRounded,
  FolderOpenRounded,
} from '@mui/icons-material'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { useState } from 'react'

import { actionLabel } from './action-label'
import ActionPicker from './action-picker'
import { makeProject, type DiversionProject } from './model'

interface ProjectEditorDialogProps {
  open: boolean
  project?: DiversionProject | null
  projectIndex: number
  onClose: () => void
  onSave: (project: DiversionProject) => void
}

const splitValues = (value: string) => {
  const items = value
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter(Boolean)
  return [...new Map(items.map((item) => [item.toLowerCase(), item])).values()]
}

const basename = (path: string) => {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

export const ProjectEditorDialog = ({
  open,
  project,
  projectIndex,
  onClose,
  onSave,
}: ProjectEditorDialogProps) => {
  const [draft, setDraft] = useState<DiversionProject>(() =>
    makeProject(projectIndex, project ?? undefined),
  )
  const [actionPickerOpen, setActionPickerOpen] = useState(false)

  const patch = (next: Partial<DiversionProject>) =>
    setDraft((previous) => ({ ...previous, ...next }))

  const chooseApplications = async () => {
    const selected = await openFileDialog({
      multiple: true,
      directory: false,
      title: '选择应用可执行文件',
    })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    patch({
      processPaths: splitValues([...draft.processPaths, ...paths].join('\n')),
      processNames: splitValues(
        [...draft.processNames, ...paths.map(basename)].join('\n'),
      ),
    })
  }

  const conditionCount =
    draft.processNames.length +
    draft.processPaths.length +
    draft.domains.length +
    draft.ipCidrs.length
  const legacyPortCount = draft.destinationPorts.length
  const canSave = Boolean(
    draft.name.trim() &&
      (!draft.enabled ||
        draft.action === 'none' ||
        conditionCount > 0 ||
        legacyPortCount > 0) &&
      (draft.action !== 'policy' || draft.policy?.trim()),
  )

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{project ? '编辑应用分流' : '新建应用分流'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              fullWidth
              size="small"
              label="名称"
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={draft.enabled}
                  onChange={(_, checked) => patch({ enabled: checked })}
                />
              }
              label="启用"
            />
          </Stack>

          <Box>
            <Typography variant="caption" color="text.secondary">
              出口
            </Typography>
            <Box sx={{ mt: 0.5 }}>
              <Button
                variant="outlined"
                onClick={() => setActionPickerOpen(true)}
                sx={{ minWidth: 240, justifyContent: 'space-between' }}
              >
                {actionLabel(draft.action, draft.policy)}
              </Button>
            </Box>
            <ActionPicker
              open={actionPickerOpen}
              title={`${draft.name || '当前应用'}的出口`}
              action={draft.action}
              policy={draft.policy}
              allowDrop
              onClose={() => setActionPickerOpen(false)}
              onSelect={(action, policy) =>
                patch({
                  action,
                  policy: action === 'policy' ? policy : undefined,
                })
              }
            />
          </Box>

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            sx={{ alignItems: { sm: 'center' } }}
          >
            <Button
              variant="contained"
              startIcon={<FolderOpenRounded />}
              onClick={() => void chooseApplications()}
            >
              选择应用
            </Button>
            <Typography variant="body2" color="text.secondary">
              已选择 {draft.processPaths.length || draft.processNames.length}{' '}
              个应用标识
            </Typography>
          </Stack>

          <Accordion
            defaultExpanded={!project || conditionCount === 0}
            disableGutters
            elevation={0}
            sx={{
              border: 1,
              borderColor: 'divider',
              borderRadius: '8px !important',
              '&::before': { display: 'none' },
            }}
          >
            <AccordionSummary expandIcon={<ExpandMoreRounded />}>
              <Box>
                <Typography variant="subtitle2">识别条件</Typography>
                <Typography variant="caption" color="text.secondary">
                  应用名称和路径优先；域名或 IP 用于核心未返回应用信息时补充识别。
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={1.5}>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
                  <TextField
                    fullWidth
                    multiline
                    minRows={3}
                    label="应用名称"
                    placeholder={'chrome.exe\nDiscord.exe'}
                    value={draft.processNames.join('\n')}
                    onChange={(event) =>
                      patch({ processNames: splitValues(event.target.value) })
                    }
                  />
                  <TextField
                    fullWidth
                    multiline
                    minRows={3}
                    label="应用完整路径"
                    placeholder={'C:\\Program Files\\App\\app.exe'}
                    value={draft.processPaths.join('\n')}
                    onChange={(event) =>
                      patch({ processPaths: splitValues(event.target.value) })
                    }
                  />
                </Stack>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
                  <TextField
                    fullWidth
                    multiline
                    minRows={3}
                    label="补充域名"
                    placeholder={'openai.com\nchatgpt.com'}
                    value={draft.domains.join('\n')}
                    onChange={(event) =>
                      patch({ domains: splitValues(event.target.value) })
                    }
                  />
                  <TextField
                    fullWidth
                    multiline
                    minRows={3}
                    label="补充 IP 或 CIDR"
                    placeholder={'1.1.1.1/32\n2606:4700::/128'}
                    value={draft.ipCidrs.join('\n')}
                    onChange={(event) =>
                      patch({ ipCidrs: splitValues(event.target.value) })
                    }
                  />
                </Stack>
              </Stack>
            </AccordionDetails>
          </Accordion>

          {legacyPortCount > 0 && (
            <Alert severity="warning">
              这条规则含有 {legacyPortCount}{' '}
              个旧版端口条件，保存时会继续保留。端口规则应在“通用规则”中维护。
            </Alert>
          )}

          {draft.enabled && draft.action !== 'none' && conditionCount === 0 &&
            legacyPortCount === 0 && (
              <Alert severity="warning">至少选择一个应用或补充识别条件。</Alert>
            )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="contained"
          startIcon={<AddRounded />}
          disabled={!canSave}
          onClick={() => onSave({ ...draft, name: draft.name.trim() })}
        >
          保存
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default ProjectEditorDialog
