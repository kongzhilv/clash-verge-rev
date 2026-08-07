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
  if (attribution?.source === 'mihomo') return '应用已由代理核心识别'
  if (attribution?.source === 'windows') return '应用已由系统识别'
  if (inferred) return '应用已由规则特征识别'
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
  const routingLabel = match ? '应用规则' : '处理方式'
  const routingValue = match
    ? `${match.project.name}${
        match.reasons.length > 0 ? ` · ${match.reasons.join(' + ')}` : ''
      }`
    : '通用规则'
  const status = routeDiffers
    ? '当前连接仍在使用旧出口'
    : match
      ? '应用规则已生效'
      : '当前按通用规则处理'
  const recognition = attributionLabel(attribution, Boolean(match?.inferred))

  return (
    <Paper
      variant="outlined"
      sx={{ borderRadius: 2, minWidth: 0, overflow: 'visible' }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ px: 1.5, py: 1.25, alignItems: 'flex-start' }}
      >
        <Box
          sx={{
            width: 34,
            height: 34,
            mt: 0.1,
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
          <Stack
            direction="row"
            spacing={0.6}
            sx={{ alignItems: 'flex-start' }}
          >
            {routeDiffers ? (
              <WarningAmberRounded
                color="warning"
                sx={{ mt: 0.15, fontSize: 16 }}
              />
            ) : match ? (
              <CheckCircleRounded
                color="success"
                sx={{ mt: 0.15, fontSize: 16 }}
              />
            ) : (
              <HourglassTopRounded
                color="disabled"
                sx={{ mt: 0.15, fontSize: 16 }}
              />
            )}
            <Typography
              variant="subtitle2"
              sx={{
                minWidth: 0,
                fontWeight: 700,
                lineHeight: 1.45,
                wordBreak: 'break-word',
                overflowWrap: 'anywhere',
              }}
            >
              {status}
            </Typography>
          </Stack>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{
              display: 'block',
              mt: 0.2,
              lineHeight: 1.45,
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
            }}
          >
            {recognition}
          </Typography>
        </Box>
      </Stack>

      <Divider />

      <Stack divider={<Divider flexItem />}>
        <Box sx={{ minWidth: 0, px: 1.5, py: 1.15 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', lineHeight: 1.35 }}
          >
            {routingLabel}
          </Typography>
          <Typography
            variant="body2"
            sx={{
              mt: 0.35,
              fontWeight: 650,
              lineHeight: 1.5,
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
            }}
          >
            {routingValue}
          </Typography>
        </Box>
        <Box sx={{ minWidth: 0, px: 1.5, py: 1.15 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', lineHeight: 1.35 }}
          >
            当前出口
          </Typography>
          <Typography
            variant="body2"
            sx={{
              mt: 0.35,
              fontWeight: 650,
              lineHeight: 1.5,
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
            }}
          >
            {currentPolicy}
          </Typography>
        </Box>
      </Stack>

      {routeDiffers && (
        <Typography
          variant="caption"
          color="warning.main"
          sx={{
            display: 'block',
            px: 1.5,
            pt: 0.2,
            pb: 1.2,
            lineHeight: 1.45,
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
          }}
        >
          预期出口为 {expectedPolicy}。重新建立连接后会按新规则匹配。
        </Typography>
      )}
    </Paper>
  )
}

export default ConnectionProjectCard
