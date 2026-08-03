import { AccountTreeRounded, CheckRounded } from '@mui/icons-material'
import {
  Alert,
  Box,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from '@mui/material'
import { useMemo } from 'react'

import { OverflowReveal, softScrollAreaSx } from '@/components/base'
import { useProxySelection } from '@/hooks/use-proxy-selection'
import { useAppRefreshers, useProxiesData } from '@/providers/app-data-context'
import { showNotice } from '@/services/notice-service'

interface RuntimeProxy {
  name?: unknown
  type?: unknown
}

interface RuntimeGroup {
  name?: unknown
  type?: unknown
  now?: unknown
  all?: unknown
}

interface FocusedPolicyPanelProps {
  policy: string
}

export const FocusedPolicyPanel = ({ policy }: FocusedPolicyPanelProps) => {
  const { proxies } = useProxiesData()
  const { refreshProxy } = useAppRefreshers()
  const { changeProxy } = useProxySelection({
    onSuccess: refreshProxy,
    onError: (error) => showNotice.error(error),
  })

  const group = useMemo(() => {
    const groups: RuntimeGroup[] = Array.isArray(proxies?.groups)
      ? proxies.groups
      : []
    return groups.find(
      (item) =>
        String(item.name ?? '')
          .trim()
          .toLowerCase() === policy.trim().toLowerCase(),
    )
  }, [policy, proxies?.groups])

  if (!group) {
    return (
      <Alert severity="warning">
        当前 Mihomo 运行时没有返回代理组“{policy}
        ”。规则仍会保留该名称，待配置中出现后生效。
      </Alert>
    )
  }

  const groupName = String(group.name ?? policy)
  const current = String(group.now ?? '')
  const proxiesInGroup: RuntimeProxy[] = Array.isArray(group.all)
    ? group.all
    : []

  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={1.5}
        sx={{ alignItems: { md: 'center' } }}
      >
        <AccountTreeRounded color="primary" />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <OverflowReveal value={groupName} fontWeight={700} />
          <Stack
            direction="row"
            spacing={0.75}
            sx={{ mt: 0.5, flexWrap: 'wrap' }}
          >
            <Chip
              size="small"
              label={`类型：${String(group.type ?? '未知')}`}
            />
            <Box
              sx={{
                display: 'inline-flex',
                minWidth: 0,
                maxWidth: { xs: '100%', sm: 360 },
                alignItems: 'center',
                gap: 0.45,
                px: 0.85,
                py: 0.15,
                border: 1,
                borderColor: 'primary.main',
                borderRadius: 999,
                color: 'primary.main',
                bgcolor: 'background.paper',
              }}
            >
              <CheckRounded sx={{ fontSize: 16, flex: '0 0 auto' }} />
              <Typography variant="caption" sx={{ flex: '0 0 auto' }}>
                当前：
              </Typography>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <OverflowReveal
                  value={current || '未选择'}
                  variant="caption"
                  fontWeight={650}
                />
              </Box>
            </Box>
            <Chip size="small" label={`${proxiesInGroup.length} 个候选节点`} />
          </Stack>
        </Box>
        <FormControl size="small" sx={{ minWidth: { xs: '100%', md: 320 } }}>
          <InputLabel>直接切换此代理组</InputLabel>
          <Select
            label="直接切换此代理组"
            value={current}
            renderValue={(selected) => (
              <OverflowReveal value={String(selected)} variant="body2" />
            )}
            MenuProps={{
              slotProps: {
                paper: {
                  sx: {
                    maxHeight: 'min(52vh, 420px)',
                    ...softScrollAreaSx,
                  },
                },
              },
            }}
            onChange={(event) =>
              changeProxy(groupName, String(event.target.value), current)
            }
          >
            {proxiesInGroup.map((proxy) => {
              const name = String(proxy.name ?? '').trim()
              const label = `${name} · ${String(proxy.type ?? '未知类型')}`
              return name ? (
                <MenuItem key={name} value={name} sx={{ minWidth: 0 }}>
                  <Box sx={{ minWidth: 0, width: '100%' }}>
                    <OverflowReveal value={label} variant="body2" />
                  </Box>
                </MenuItem>
              ) : null
            })}
          </Select>
        </FormControl>
      </Stack>
    </Paper>
  )
}

export default FocusedPolicyPanel
