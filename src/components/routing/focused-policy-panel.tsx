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
          <Typography sx={{ fontWeight: 700 }}>{groupName}</Typography>
          <Stack
            direction="row"
            spacing={0.75}
            sx={{ mt: 0.5, flexWrap: 'wrap' }}
          >
            <Chip
              size="small"
              label={`类型：${String(group.type ?? '未知')}`}
            />
            <Chip
              size="small"
              color="primary"
              icon={<CheckRounded />}
              label={`当前：${current || '未选择'}`}
            />
            <Chip size="small" label={`${proxiesInGroup.length} 个候选节点`} />
          </Stack>
        </Box>
        <FormControl size="small" sx={{ minWidth: { xs: '100%', md: 300 } }}>
          <InputLabel>直接切换此代理组</InputLabel>
          <Select
            label="直接切换此代理组"
            value={current}
            onChange={(event) =>
              changeProxy(groupName, String(event.target.value), current)
            }
          >
            {proxiesInGroup.map((proxy) => {
              const name = String(proxy.name ?? '').trim()
              return name ? (
                <MenuItem key={name} value={name}>
                  {name} · {String(proxy.type ?? '未知类型')}
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
