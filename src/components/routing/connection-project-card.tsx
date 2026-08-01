import {
  AccountTreeRounded,
  AppsRounded,
  HubRounded,
  LanRounded,
  WarningAmberRounded,
} from '@mui/icons-material'
import { Box, Button, Chip, Paper, Stack, Typography } from '@mui/material'
import { useMemo } from 'react'
import { useNavigate } from 'react-router'

import { useDiversionProfile } from '@/hooks/use-diversion-profile'

import { resolveConnectionProject } from './connection-project'

interface ConnectionProjectCardProps {
  connection: IConnectionsItem
}

export const ConnectionProjectCard = ({
  connection,
}: ConnectionProjectCardProps) => {
  const navigate = useNavigate()
  const { profile } = useDiversionProfile()
  const match = useMemo(
    () => resolveConnectionProject(connection, profile?.config),
    [connection, profile?.config],
  )

  if (!match) {
    return (
      <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
        <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
          <Box sx={{ color: 'text.secondary', display: 'flex' }}>
            <AppsRounded />
          </Box>
          <Box sx={{ flex: 1 }}>
            <Typography variant="subtitle2">未关联程序或项目</Typography>
            <Typography variant="body2" color="text.secondary">
              可登记程序路径、域名、IP
              或端口，让连接、规则和代理组共用同一档案。
            </Typography>
          </Box>
          <Button
            size="small"
            onClick={() => navigate('/rules?manage=projects')}
          >
            添加档案
          </Button>
        </Stack>
      </Paper>
    )
  }

  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <AccountTreeRounded color="primary" />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2">{match.project.name}</Typography>
            {match.project.description && (
              <Typography variant="body2" color="text.secondary">
                {match.project.description}
              </Typography>
            )}
          </Box>
          {match.inferred && (
            <Chip
              size="small"
              color="warning"
              icon={<WarningAmberRounded />}
              label="特征推断"
            />
          )}
        </Stack>

        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
          <Chip size="small" label={`依据：${match.reasons.join(' + ')}`} />
          <Chip
            size="small"
            icon={<HubRounded />}
            label={`规则组：${match.project.groupId}`}
          />
          {match.policy && (
            <Chip
              size="small"
              color="primary"
              variant="outlined"
              icon={<LanRounded />}
              label={`出口：${match.policy}`}
            />
          )}
        </Stack>

        <Stack direction="row" spacing={0.5}>
          <Button
            size="small"
            onClick={() =>
              navigate(`/rules?project=${encodeURIComponent(match.project.id)}`)
            }
          >
            编辑档案与规则
          </Button>
          {match.policy && (
            <Button
              size="small"
              onClick={() =>
                navigate(`/proxies?policy=${encodeURIComponent(match.policy)}`)
              }
            >
              查看代理组
            </Button>
          )}
        </Stack>
      </Stack>
    </Paper>
  )
}

export default ConnectionProjectCard
