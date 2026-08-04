import {
  AppsRounded,
  ArrowForwardRounded,
  CheckCircleRounded,
  WarningAmberRounded,
} from '@mui/icons-material'
import { Box, Divider, Paper, Stack, Typography } from '@mui/material'
import { useMemo } from 'react'

import { useDiversionProfile } from '@/hooks/use-diversion-profile'

import { resolveConnectionProject } from './connection-project'

interface ConnectionProjectCardProps {
  connection: IConnectionsItem
}

const processNameFrom = (process: string, processPath: string) => {
  const preferred = process.trim()
  if (preferred) return preferred
  return processPath.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}

interface RouteStageProps {
  label: string
  value: string
}

const RouteStage = ({ label, value }: RouteStageProps) => (
  <Box sx={{ flex: 1, minWidth: 0 }}>
    <Typography variant="caption" color="text.secondary">
      {label}
    </Typography>
    <Typography
      variant="body2"
      sx={{ mt: 0.2, fontWeight: 650, wordBreak: 'break-word' }}
      title={value}
    >
      {value}
    </Typography>
  </Box>
)

export const ConnectionProjectCard = ({
  connection,
}: ConnectionProjectCardProps) => {
  const { profile } = useDiversionProfile()
  const match = useMemo(
    () => resolveConnectionProject(connection, profile?.config),
    [connection, profile?.config],
  )

  const processPath = String(connection.metadata.processPath ?? '').trim()
  const processName = processNameFrom(
    String(connection.metadata.process ?? ''),
    processPath,
  )
  const applicationName = processName || match?.project.name || '未识别应用'
  const applicationRule = match?.project.name || '未设置'
  const expectedPolicy = match?.policy || ''
  const currentPolicy = connection.chains.at(-1)?.trim() || '未返回'
  const routeDiffers =
    Boolean(expectedPolicy) &&
    currentPolicy !== '未返回' &&
    !connection.chains.some(
      (item) => item.trim().toLowerCase() === expectedPolicy.toLowerCase(),
    )
  const status = !match
    ? '未设置应用规则'
    : routeDiffers
      ? '等待新连接应用规则'
      : '按应用规则运行'

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
            bgcolor: match ? 'success.main' : 'action.hover',
            color: match ? 'success.contrastText' : 'text.secondary',
          }}
        >
          <AppsRounded fontSize="small" />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>
            {applicationName}
          </Typography>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            {routeDiffers ? (
              <WarningAmberRounded color="warning" sx={{ fontSize: 15 }} />
            ) : match ? (
              <CheckCircleRounded color="success" sx={{ fontSize: 15 }} />
            ) : null}
            <Typography
              variant="caption"
              color={routeDiffers ? 'warning.main' : 'text.secondary'}
            >
              {status}
            </Typography>
          </Stack>
        </Box>
      </Stack>

      <Divider />

      <Stack
        direction="row"
        spacing={0.75}
        sx={{ px: 1.5, py: 1.25, alignItems: 'center' }}
      >
        <RouteStage label="应用" value={applicationName} />
        <ArrowForwardRounded sx={{ color: 'text.disabled', fontSize: 18 }} />
        <RouteStage label="应用规则" value={applicationRule} />
        <ArrowForwardRounded sx={{ color: 'text.disabled', fontSize: 18 }} />
        <RouteStage label="当前出口" value={currentPolicy} />
      </Stack>

      {routeDiffers && (
        <Typography
          variant="caption"
          color="warning.main"
          sx={{ display: 'block', px: 1.5, pb: 1.2 }}
        >
          预期出口为 {expectedPolicy}。断开并重新建立连接后会按新规则匹配。
        </Typography>
      )}
    </Paper>
  )
}

export default ConnectionProjectCard
