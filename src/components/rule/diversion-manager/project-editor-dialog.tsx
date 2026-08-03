import { AddRounded, FolderOpenRounded } from '@mui/icons-material'
import {
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
    const processPaths = splitValues(
      [...draft.processPaths, ...paths].join('\n'),
    )
    const processNames = splitValues(
      [...draft.processNames, ...paths.map(basename)].join('\n'),
    )
    patch({ processPaths, processNames })
  }

  const conditionCount =
    draft.processNames.length +
    draft.processPaths.length +
    draft.domains.length +
    draft.ipCidrs.length +
    draft.destinationPorts.length
  const canSave = Boolean(
    draft.name.trim() &&
      (!draft.enabled || draft.action === 'none' || conditionCount > 0) &&
      (draft.action !== 'policy' || draft.policy?.trim()),
  )

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{project ? '编辑应用规则' : '新建应用规则'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity="info">
            应用规则将识别条件与一个出口策略绑定，并生成真实的 Mihomo
            规则。应用信息缺失时，仍可使用域名、IP 或端口匹配。
          </Alert>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              fullWidth
              size="small"
              label="规则名称"
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

          <TextField
            fullWidth
            size="small"
            label="说明"
            value={draft.description}
            onChange={(event) => patch({ description: event.target.value })}
          />

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              出口策略
            </Typography>
            <Button
              variant="outlined"
              onClick={() => setActionPickerOpen(true)}
              sx={{ minWidth: 240, justifyContent: 'space-between' }}
            >
              {actionLabel(draft.action, draft.policy)}
            </Button>
            <ActionPicker
              open={actionPickerOpen}
              title={`${draft.name || '当前应用规则'}的出口策略`}
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

          {draft.action === 'policy' && (
            <TextField
              fullWidth
              size="small"
              label="指定代理组或节点名称"
              value={draft.policy ?? ''}
              onChange={(event) => patch({ policy: event.target.value })}
            />
          )}

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button
              variant="contained"
              startIcon={<FolderOpenRounded />}
              onClick={() => void chooseApplications()}
            >
              选择应用文件
            </Button>
            <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
              选择后会同时登记完整路径和应用文件名，也可继续手动修改。
            </Typography>
          </Stack>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <TextField
              fullWidth
              multiline
              minRows={4}
              label="应用名称"
              placeholder={'chrome.exe\nDiscord.exe'}
              value={draft.processNames.join('\n')}
              onChange={(event) =>
                patch({ processNames: splitValues(event.target.value) })
              }
              helperText="每行一个；代理核心或 Windows 识别成功时优先精确匹配。"
            />
            <TextField
              fullWidth
              multiline
              minRows={4}
              label="应用完整路径"
              placeholder={'C:\\Program Files\\App\\app.exe\n/opt/app/app'}
              value={draft.processPaths.join('\n')}
              onChange={(event) =>
                patch({ processPaths: splitValues(event.target.value) })
              }
              helperText="每行一个；可用上面的系统文件选择器添加。"
            />
          </Stack>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <TextField
              fullWidth
              multiline
              minRows={4}
              label="域名或域名后缀"
              placeholder={'openai.com\nchatgpt.com'}
              value={draft.domains.join('\n')}
              onChange={(event) =>
                patch({ domains: splitValues(event.target.value) })
              }
              helperText="应用信息缺失时，可根据连接域名识别并路由。"
            />
            <TextField
              fullWidth
              multiline
              minRows={4}
              label="目标 IP 或 CIDR"
              placeholder={'1.1.1.1/32\n2606:4700::/128'}
              value={draft.ipCidrs.join('\n')}
              onChange={(event) =>
                patch({ ipCidrs: splitValues(event.target.value) })
              }
              helperText="支持 IPv4 CIDR；IPv6 精确地址建议使用 /128。"
            />
            <TextField
              fullWidth
              multiline
              minRows={4}
              label="目标端口"
              placeholder={'443\n8000-9000'}
              value={draft.destinationPorts.join('\n')}
              onChange={(event) =>
                patch({ destinationPorts: splitValues(event.target.value) })
              }
              helperText="端口只作为辅助特征；支持单端口和范围。"
            />
          </Stack>

          <Alert severity={conditionCount > 0 ? 'success' : 'warning'}>
            当前应用规则包含 {conditionCount}{' '}
            个识别条件。至少需要一个条件才能启用并保存。
          </Alert>
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
          保存应用规则
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default ProjectEditorDialog
