import {
  AppsRounded,
  ArrowForwardRounded,
  LanRounded,
  RuleRounded,
} from '@mui/icons-material'
import { Box, Button, Divider, Paper, Stack, Typography } from '@mui/material'
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
  source: 'mihomo' | 'windows' | 'unresolved' | undefined,
  match: 'core' | 'tuple' | 'local-port' | 'none' | undefined,
) => {
  if (source === 'mihomo') return '由代理核心识别'
  if (source === 'windows' && match === 'tuple') {
    return '由 Windows 连接端点精确识别'
  }
  if (source === 'windows' && match === 'local-port') {
    return '由 Windows 唯一源端口识别（TUN）'
  }
  return '暂未识别应用'
}

interface RelationRowProps {
  label: string
  value: string
}

const RelationRow = ({ label, value }: RelationRowProps) => (
  <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{ width: 68, flex: '0 0 auto' }}
    >
      {label}
    </Typography>
    <Typography variant="body2" sx={{ minWidth: 0, wordBreak: 'break-all' }}>
      {value}
    </Typography>
  </Stack>
)

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
  const applicationName = processName || match?.project.name || '未识别应用'
  const applicationDetail =
    processPath ||
    attribution?.detail ||
    (match
      ? `依据 ${match.reasons.join('、')} 识别`
      : '当前连接没有可用的应用信息')
  const expectedPolicy = match?.policy || '未设置'
  const actualRule = connection.rule || '未返回'
  const actualOutbound =
    [...connection.chains].reverse().join(' / ') || '未返回'
  const routeDiffers =
    match?.policy &&
    actualOutbound !== '未返回' &&
    !connection.chains.some(
      (item) => item.trim().toLowerCase() === match.policy.toLowerCase(),
    )

  return (
    <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
      <Stack direction="row" spacing={1.25} sx={{ p: 1.5, alignItems: 'center' }}>
        <Box
          sx={{
            width: 38,
            height: 38,
            flex: '0 0 auto',
            display: 'grid',
            placeItems: 'center',
            borderRadius: 2,
            bgcolor: processName || match ? 'success.main' : 'action.hover',
            color:
              processName || match ? 'success.contrastText' : 'text.secondary',
          }}
        >
          <AppsRounded fontSize="small" />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>
            {applicationName}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', wordBreak: 'break-all' }}
          >
            {applicationDetail}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {attributionLabel(attribution?.source, attribution?.match)}
            {attribution?.pid !== undefined ? ` · PID ${attribution.pid}` : ''}
          </Typography>
        </Box>
      </Stack>

      <Divider />

      <Stack spacing={0.75} sx={{ px: 1.5, py: 1.25 }}>
        <RelationRow
          label="应用规则"
          value={match?.project.name || '未设置'}
        />
        <RelationRow label="预期出口" value={expectedPolicy} />
        <RelationRow label="命中规则" value={actualRule} />
        <RelationRow label="实际出口" value={actualOutbound} />
        {routeDiffers && (
          <Typography variant="caption" color="warning.main">
            当前连接未经过预期出口；保存后需重新建立连接才能重新匹配。
          </Typography>
        )}
      </Stack>

      <Divider />

      <Stack direction="row" spacing={0.5} sx={{ px: 1, py: 0.5 }}>
        <Button
          size="small"
          startIcon={<RuleRounded />}
          onClick={() =>
            navigate(
              match
                ? `/rules?project=${encodeURIComponent(match.project.id)}`
                : '/rules?manage=projects',
            )
          }
        >
          {match ? '编辑应用分流' : '设置应用分流'}
        </Button>
        {match?.policy && (
          <Button
            size="small"
            startIcon={<LanRounded />}
            endIcon={<ArrowForwardRounded />}
            onClick={() =>
              navigate(`/proxies?policy=${encodeURIComponent(match.policy)}`)
            }
          >
            出口
          </Button>
        )}
      </Stack>
    </Paper>
  )
}

export default ConnectionProjectCard
