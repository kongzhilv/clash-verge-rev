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

import { softScrollAreaSx } from '@/components/base'
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
          <Typography
            variant="body2"
            sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}
          >
            {groupName}
          </Typography>
          <Stack
            direction="row"
            spacing={0.75}
            sx={{ mt: 0.5, flexWrap: 'wrap' }}
          >
            <Chip
              size="small"
              label={`类型：${String(group.type ?? '未知')}`}
            />
            <Stack
              direction="row"
              spacing={0.45}
              sx={{
                minWidth: 0,
                maxWidth: '100%',
                alignItems: 'flex-start',
                px: 0.85,
                py: 0.25,
                border: 1,
                borderColor: 'primary.main',
                borderRadius: 2,
                color: 'primary.main',
                bgcolor: 'background.paper',
              }}
            >
              <CheckRounded sx={{ fontSize: 16, flex: '0 0 auto', mt: 0.05 }} />
              <Typography
                variant="caption"
                sx={{ minWidth: 0, fontWeight: 650, overflowWrap: 'anywhere' }}
              >
                当前：{current || '未选择'}
              </Typography>
            </Stack>
            <Chip size="small" label={`${proxiesInGroup.length} 个候选节点`} />
          </Stack>
        </Box>
        <FormControl
          fullWidth
          size="small"
          sx={{ width: { md: 360 }, flex: { md: '0 0 360px' } }}
        >
          <InputLabel>直接切换此代理组</InputLabel>
          <Select
            label="直接切换此代理组"
            value={current}
            renderValue={(selected) => (
              <Typography
                component="span"
                variant="body2"
                title={String(selected)}
                sx={{
                  display: 'block',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {String(selected)}
              </Typography>
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
                <MenuItem
                  key={name}
                  value={name}
                  sx={{
                    minWidth: 0,
                    whiteSpace: 'normal',
                    alignItems: 'flex-start',
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{ minWidth: 0, overflowWrap: 'anywhere' }}
                  >
                    {label}
                  </Typography>
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
