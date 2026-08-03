import {
  AppsRounded,
  ArrowForwardRounded,
  LanRounded,
  RuleRounded,
  WarningAmberRounded,
} from '@mui/icons-material'
import { Box, Button, Chip, Paper, Stack, Typography } from '@mui/material'
import { useMemo } from 'react'
import { useNavigate } from 'react-router'

import { useConnectionProcessAttribution } from '@/hooks/use-connection-data'
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

const attributionLabel = (
  source?: 'mihomo' | 'windows' | 'unresolved',
  match?: 'core' | 'tuple' | 'local-port' | 'none',
) => {
  if (source === 'mihomo') return '核心识别'
  if (source === 'windows' && match === 'tuple') return 'Windows 精确匹配'
  if (source === 'windows' && match === 'local-port') return 'Windows TUN 归因'
  return '应用未识别'
}

export const ConnectionProjectCard = ({
  connection,
}: ConnectionProjectCardProps) => {
  const navigate = useNavigate()
  const { profile } = useDiversionProfile()
  const attribution = useConnectionProcessAttribution(connection.id)
  const match = useMemo(
    () => resolveConnectionProject(connection, profile?.config),
    [connection, profile?.config],
  )

  const processPath = String(connection.metadata.processPath ?? '').trim()
  const processName = processNameFrom(
    String(connection.metadata.process ?? ''),
    processPath,
  )
  const applicationName = processName || match?.project.name || '应用未识别'
  const applicationDetail =
    processPath ||
    attribution?.detail ||
    (match
      ? '已通过域名、IP 或端口命中应用规则'
      : '系统和代理核心暂未提供可用的应用信息')
  const ruleName = match?.project.name || '未设置应用规则'
  const actualChain = [...connection.chains].reverse()
  const outlet = match?.policy || actualChain[0] || '未返回出口'
  const hasApplication = Boolean(processName || match)

  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
      <Stack spacing={1.25}>
        <Stack direction="row" spacing={1.25} sx={{ alignItems: 'flex-start' }}>
          <Box
            sx={{
              width: 40,
              height: 40,
              flex: '0 0 auto',
              display: 'grid',
              placeItems: 'center',
              borderRadius: 2,
              bgcolor: hasApplication ? 'success.main' : 'action.hover',
              color: hasApplication ? 'success.contrastText' : 'text.secondary',
            }}
          >
            <AppsRounded />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Stack
              direction="row"
              spacing={0.75}
              sx={{ alignItems: 'center', flexWrap: 'wrap' }}
            >
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {applicationName}
              </Typography>
              <Chip
                size="small"
                color={hasApplication ? 'success' : 'default'}
                variant="outlined"
                label={attributionLabel(
                  attribution?.source,
                  attribution?.match,
                )}
              />
              {match?.inferred && (
                <Chip
                  size="small"
                  color="warning"
                  icon={<WarningAmberRounded />}
                  label="连接特征"
                />
              )}
            </Stack>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 0.25, wordBreak: 'break-all' }}
            >
              {applicationDetail}
            </Typography>
            {attribution?.pid !== undefined && (
              <Typography variant="caption" color="text.secondary">
                PID {attribution.pid}
              </Typography>
            )}
          </Box>
        </Stack>

        <Stack
          direction="row"
          spacing={0.75}
          sx={{
            alignItems: 'center',
            flexWrap: 'wrap',
            px: 1,
            py: 0.75,
            borderRadius: 1.5,
            bgcolor: 'action.hover',
          }}
        >
          <AppsRounded fontSize="small" color="action" />
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {applicationName}
          </Typography>
          <ArrowForwardRounded fontSize="small" color="action" />
          <RuleRounded fontSize="small" color="action" />
          <Typography variant="body2">{ruleName}</Typography>
          <ArrowForwardRounded fontSize="small" color="action" />
          <LanRounded fontSize="small" color="action" />
          <Typography variant="body2">{outlet}</Typography>
        </Stack>

        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
          <Button
            size="small"
            onClick={() =>
              navigate(
                match
                  ? `/rules?project=${encodeURIComponent(match.project.id)}`
                  : '/rules?manage=projects',
              )
            }
          >
            {match ? '编辑应用规则' : '创建应用规则'}
          </Button>
          {match?.policy && (
            <Button
              size="small"
              onClick={() =>
                navigate(`/proxies?policy=${encodeURIComponent(match.policy)}`)
              }
            >
              查看出口策略
            </Button>
          )}
        </Stack>
      </Stack>
    </Paper>
  )
}

export default ConnectionProjectCard
