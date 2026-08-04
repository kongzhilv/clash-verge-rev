import {
  CheckCircleRounded,
  HourglassTopRounded,
  RouteRounded,
  WarningAmberRounded,
} from '@mui/icons-material'
import { Box, Divider, Paper, Stack, Typography } from '@mui/material'
import { useMemo } from 'react'

import { useConnectionProcessAttribution } from '@/hooks/use-connection-data'
import { useDiversionProfile } from '@/hooks/use-diversion-profile'

import { resolveConnectionProject } from './connection-project'

interface ConnectionProjectCardProps {
  connection: IConnectionsItem
}

const attributionLabel = (
  attribution: ReturnType<typeof useConnectionProcessAttribution>,
  inferred: boolean,
) => {
  if (attribution?.source === 'mihomo') return '代理核心识别应用'
  if (attribution?.source === 'windows') {
    if (attribution.match === 'tuple') return 'Windows 精确端点识别'
    if (attribution.match === 'local-endpoint') return 'Windows TUN 端点识别'
    if (attribution.match === 'local-port') return 'Windows 唯一端口识别'
    return 'Windows 最近连接记录识别'
  }
  if (inferred) return '应用规则特征识别'
  return '尚未识别应用'
}

export const ConnectionProjectCard = ({
  connection,
}: ConnectionProjectCardProps) => {
  const { profile } = useDiversionProfile()
  const attribution = useConnectionProcessAttribution(connection.id)
  const match = useMemo(
    () => resolveConnectionProject(connection, profile?.config),
    [connection, profile?.config],
  )

  const expectedPolicy = match?.policy || ''
  const currentPolicy = connection.chains.at(-1)?.trim() || '未返回'
  const routeDiffers =
    Boolean(expectedPolicy) &&
    currentPolicy !== '未返回' &&
    !connection.chains.some(
      (item) => item.trim().toLowerCase() === expectedPolicy.toLowerCase(),
    )
  const ruleLabel = match
    ? `${match.project.name}${
        match.reasons.length > 0 ? ` · ${match.reasons.join(' + ')}` : ''
      }`
    : connection.rulePayload
      ? `${connection.rule} · ${connection.rulePayload}`
      : connection.rule || '未返回'
  const status = routeDiffers
    ? '当前连接仍在使用旧出口'
    : match
      ? '应用规则已生效'
      : '当前按通用规则处理'
  const recognition = attributionLabel(attribution, Boolean(match?.inferred))

  return (
    <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ px: 1.5, py: 1.1, alignItems: 'center' }}
      >
        <Box
          sx={{
            width: 34,
            height: 34,
            flex: '0 0 auto',
            display: 'grid',
            placeItems: 'center',
            borderRadius: 1.5,
            bgcolor: routeDiffers
              ? 'warning.main'
              : match
                ? 'success.main'
                : 'action.hover',
            color:
              routeDiffers || match ? 'primary.contrastText' : 'text.secondary',
          }}
        >
          <RouteRounded fontSize="small" />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={0.6} sx={{ alignItems: 'center' }}>
            {routeDiffers ? (
              <WarningAmberRounded color="warning" sx={{ fontSize: 16 }} />
            ) : match ? (
              <CheckCircleRounded color="success" sx={{ fontSize: 16 }} />
            ) : (
              <HourglassTopRounded color="disabled" sx={{ fontSize: 16 }} />
            )}
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {status}
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary" noWrap>
            {recognition}
          </Typography>
        </Box>
      </Stack>

      <Divider />

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.45fr) minmax(0, 1fr)',
        }}
      >
        <Box sx={{ minWidth: 0, px: 1.5, py: 1.25 }}>
          <Typography variant="caption" color="text.secondary">
            {match ? '应用规则' : '通用规则'}
          </Typography>
          <Typography
            variant="body2"
            sx={{ mt: 0.2, fontWeight: 650, wordBreak: 'break-word' }}
            title={ruleLabel}
          >
            {ruleLabel}
          </Typography>
        </Box>
        <Box
          sx={{
            minWidth: 0,
            px: 1.5,
            py: 1.25,
            borderLeft: 1,
            borderColor: 'divider',
          }}
        >
          <Typography variant="caption" color="text.secondary">
            当前出口
          </Typography>
          <Typography
            variant="body2"
            sx={{ mt: 0.2, fontWeight: 650, wordBreak: 'break-word' }}
            title={currentPolicy}
          >
            {currentPolicy}
          </Typography>
        </Box>
      </Box>

      {routeDiffers && (
        <Typography
          variant="caption"
          color="warning.main"
          sx={{ display: 'block', px: 1.5, pb: 1.2 }}
        >
          预期出口为 {expectedPolicy}。重新建立连接后会按新规则匹配。
        </Typography>
      )}
    </Paper>
  )
}

export default ConnectionProjectCard
