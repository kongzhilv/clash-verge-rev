import {
  AccountTreeRounded,
  AutoAwesomeRounded,
  BlockRounded,
  CheckRounded,
  ChevronRightRounded,
  DeleteSweepRounded,
  DoNotDisturbAltRounded,
  LinkRounded,
  RadioButtonCheckedRounded,
  SearchRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { useProxiesData } from '@/providers/app-data-context'

import type { Action } from './model'

interface ActionPickerProps {
  open: boolean
  title: string
  action: Action
  policy?: string
  allowNone?: boolean
  allowDrop?: boolean
  onClose: () => void
  onSelect: (action: Action, policy?: string) => void
}

interface ActionOption {
  action: Action
  label: string
  description: string
  icon: ReactNode
}

const BASE_ACTIONS: ActionOption[] = [
  {
    action: 'none',
    label: '无（不使用）',
    description: '停用这条规则，但保留规则内容。',
    icon: <DoNotDisturbAltRounded />,
  },
  {
    action: 'current',
    label: '当前选择',
    description: '跟随主界面当前手动选择的节点或策略。',
    icon: <RadioButtonCheckedRounded />,
  },
  {
    action: 'auto-select',
    label: '自动选择',
    description: '自动从全部可用节点中选择延迟较低的节点。',
    icon: <AutoAwesomeRounded />,
  },
  {
    action: 'direct',
    label: '直连',
    description: '不经过代理，直接访问目标。',
    icon: <LinkRounded />,
  },
  {
    action: 'reject',
    label: '拦截',
    description: '拒绝匹配到的连接，适合广告或不需要的流量。',
    icon: <BlockRounded />,
  },
]

const supportedPolicyType = (value: unknown) => {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replaceAll('-', '')
  return [
    'selector',
    'select',
    'urltest',
    'fallback',
    'loadbalance',
    'relay',
  ].includes(normalized)
}

export const actionLabel = (action: Action, policy?: string) => {
  if (action === 'policy') return policy ? `指定策略：${policy}` : '指定策略组'
  if (action === 'reject-drop') return '静默拦截'
  return (
    BASE_ACTIONS.find((option) => option.action === action)?.label ?? action
  )
}

export const ActionPicker = ({
  open,
  title,
  action,
  policy,
  allowNone = true,
  allowDrop = false,
  onClose,
  onSelect,
}: ActionPickerProps) => {
  const { proxies } = useProxiesData()
  const [search, setSearch] = useState('')
  const [manualPolicy, setManualPolicy] = useState(policy ?? '')

  useEffect(() => {
    if (!open) return
    setSearch('')
    setManualPolicy(policy ?? '')
  }, [open, policy])

  const policyGroups = useMemo(() => {
    const groups = Array.isArray(proxies?.groups) ? proxies.groups : []
    const names = groups
      .filter((group: any) => supportedPolicyType(group?.type))
      .map((group: any) => String(group?.name ?? '').trim())
      .filter(Boolean)

    return [...new Set(names)].sort((left, right) =>
      left.localeCompare(right, 'zh-CN'),
    )
  }, [proxies?.groups])

  const filteredPolicies = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return policyGroups
    return policyGroups.filter((name) => name.toLowerCase().includes(keyword))
  }, [policyGroups, search])

  const choose = (nextAction: Action, nextPolicy?: string) => {
    onSelect(nextAction, nextAction === 'policy' ? nextPolicy : undefined)
    onClose()
  }

  const actions = BASE_ACTIONS.filter(
    (option) => allowNone || option.action !== 'none',
  )

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <List disablePadding>
          {actions.map((option) => (
            <ListItemButton
              key={option.action}
              selected={action === option.action}
              onClick={() => choose(option.action)}
            >
              <ListItemIcon>{option.icon}</ListItemIcon>
              <ListItemText
                primary={option.label}
                secondary={option.description}
              />
              {action === option.action ? (
                <CheckRounded color="primary" />
              ) : (
                <ChevronRightRounded color="disabled" />
              )}
            </ListItemButton>
          ))}
          {allowDrop && (
            <ListItemButton
              selected={action === 'reject-drop'}
              onClick={() => choose('reject-drop')}
            >
              <ListItemIcon>
                <DeleteSweepRounded />
              </ListItemIcon>
              <ListItemText
                primary="静默拦截"
                secondary="直接丢弃连接，不返回拒绝响应。"
              />
              {action === 'reject-drop' ? (
                <CheckRounded color="primary" />
              ) : (
                <ChevronRightRounded color="disabled" />
              )}
            </ListItemButton>
          )}
        </List>

        <Divider />

        <Box sx={{ p: 2 }}>
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center', mb: 1 }}
          >
            <AccountTreeRounded color="action" />
            <Box>
              <Typography sx={{ fontWeight: 700 }}>现有策略组</Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                对应 Karing 服务器选择页中的测速组和自定义组。
              </Typography>
            </Box>
          </Stack>

          {policyGroups.length > 6 && (
            <TextField
              fullWidth
              size="small"
              value={search}
              placeholder="搜索策略组"
              onChange={(event) => setSearch(event.target.value)}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchRounded fontSize="small" />
                    </InputAdornment>
                  ),
                },
              }}
              sx={{ mb: 1 }}
            />
          )}

          {filteredPolicies.length > 0 ? (
            <List
              disablePadding
              sx={{
                maxHeight: 260,
                overflowY: 'auto',
                border: 1,
                borderColor: 'divider',
                borderRadius: 1.5,
              }}
            >
              {filteredPolicies.map((name) => (
                <ListItemButton
                  key={name}
                  selected={action === 'policy' && policy === name}
                  onClick={() => choose('policy', name)}
                >
                  <ListItemIcon>
                    <AccountTreeRounded />
                  </ListItemIcon>
                  <ListItemText primary={name} />
                  {action === 'policy' && policy === name && (
                    <CheckRounded color="primary" />
                  )}
                </ListItemButton>
              ))}
            </List>
          ) : (
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
              当前核心没有返回可选策略组，仍可在下方手动输入名称。
            </Typography>
          )}

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            sx={{ mt: 1 }}
          >
            <TextField
              fullWidth
              size="small"
              label="手动输入策略组或节点名称"
              value={manualPolicy}
              onChange={(event) => setManualPolicy(event.target.value)}
            />
            <Button
              variant="outlined"
              disabled={!manualPolicy.trim()}
              onClick={() => choose('policy', manualPolicy.trim())}
            >
              选择
            </Button>
          </Stack>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
      </DialogActions>
    </Dialog>
  )
}

export default ActionPicker
