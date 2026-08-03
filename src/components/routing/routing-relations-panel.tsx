import {
  AccountTreeRounded,
  AppsRounded,
  ArrowForwardRounded,
  HubRounded,
  LanRounded,
  LinkRounded,
  RuleRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import { useMemo } from 'react'
import { useNavigate } from 'react-router'

import {
  resolveActionPolicy,
  type DiversionConfig,
  type DiversionProject,
} from '@/components/rule/diversion-manager/model'
import { useConnectionData } from '@/hooks/use-connection-data'
import { useDiversionProfile } from '@/hooks/use-diversion-profile'

import {
  connectionUsesPolicy,
  resolveConnectionProject,
} from './connection-project'

interface RoutingRelationsPanelProps {
  policyFilter?: string | null
  compact?: boolean
}

const connectionCountForProject = (
  project: DiversionProject,
  connections: IConnectionsItem[],
  config: DiversionConfig,
) =>
  connections.filter(
    (connection) =>
      resolveConnectionProject(connection, config)?.project.id === project.id,
  ).length

export const RoutingRelationsPanel = ({
  policyFilter,
  compact = false,
}: RoutingRelationsPanelProps) => {
  const navigate = useNavigate()
  const { profile, loading } = useDiversionProfile()
  const {
    response: { data: connections },
  } = useConnectionData({ enabled: true })

  const activeConnections = connections?.activeConnections ?? []
  const projects = useMemo(() => {
    if (!profile) return []
    const expected = policyFilter?.trim().toLowerCase()
    return profile.config.projects.filter((project) => {
      if (!expected) return true
      return (
        resolveActionPolicy(profile.config, project.action, project.policy)
          .trim()
          .toLowerCase() === expected
      )
    })
  }, [policyFilter, profile])

  if (loading) return null

  if (!profile || profile.config.projects.length === 0) {
    return (
      <Alert
        severity="info"
        action={
          <Button
            color="inherit"
            size="small"
            onClick={() => navigate('/rules?manage=projects')}
          >
            新建
          </Button>
        }
      >
        尚未建立程序分流关系。
      </Alert>
    )
  }

  if (policyFilter && projects.length === 0) {
    return (
      <Alert
        severity="warning"
        action={
          <Button
            color="inherit"
            size="small"
            onClick={() => navigate('/proxies')}
          >
            清除
          </Button>
        }
      >
        没有项目使用“{policyFilter}”。
      </Alert>
    )
  }

  return (
    <Paper variant="outlined" sx={{ borderRadius: 2.5, overflow: 'hidden' }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ px: 1.5, py: 1.15, alignItems: 'center' }}
      >
        <AccountTreeRounded color="primary" fontSize="small" />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 700 }}>分流关系</Typography>
          {!compact && (
            <Typography variant="caption" color="text.secondary">
              程序 → 规则 → 出口
            </Typography>
          )}
        </Box>
        <Tooltip title="管理项目">
          <IconButton
            size="small"
            onClick={() => navigate('/rules?manage=projects')}
          >
            <AppsRounded fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      <Divider />
      <Stack
        divider={<Divider flexItem />}
        sx={{ maxHeight: compact ? 220 : 320, overflowY: 'auto' }}
      >
        {projects.map((project) => {
          const policy = resolveActionPolicy(
            profile.config,
            project.action,
            project.policy,
          )
          const matchedConnections = connectionCountForProject(
            project,
            activeConnections,
            profile.config,
          )
          const policyConnections = policy
            ? activeConnections.filter((connection) =>
                connectionUsesPolicy(connection, policy),
              ).length
            : 0

          return (
            <Stack
              key={project.id}
              direction="row"
              spacing={1}
              sx={{ px: 1.25, py: 0.9, alignItems: 'center', minWidth: 0 }}
            >
              <AppsRounded
                color={project.enabled ? 'primary' : 'disabled'}
                fontSize="small"
              />
              <Typography
                sx={{ width: compact ? 110 : 150, fontWeight: 650 }}
                noWrap
                title={project.name}
              >
                {project.name}
              </Typography>

              <Stack
                direction="row"
                spacing={0.5}
                sx={{ flex: 1, minWidth: 0, alignItems: 'center' }}
              >
                <Chip
                  size="small"
                  icon={<HubRounded />}
                  label={project.groupId}
                  variant="outlined"
                  sx={{ maxWidth: compact ? 120 : 180 }}
                />
                <ArrowForwardRounded fontSize="inherit" color="disabled" />
                <Chip
                  size="small"
                  icon={<LanRounded />}
                  label={policy || '无出口'}
                  color={policy ? 'primary' : 'default'}
                  variant="outlined"
                  sx={{ maxWidth: compact ? 120 : 180 }}
                />
              </Stack>

              <Tooltip
                title={`项目连接 ${matchedConnections} · 出口连接 ${policyConnections}`}
              >
                <Chip size="small" label={matchedConnections} />
              </Tooltip>

              <Stack direction="row" spacing={0.1}>
                <Tooltip title="连接">
                  <IconButton
                    size="small"
                    onClick={() =>
                      navigate(
                        `/connections?project=${encodeURIComponent(project.id)}`,
                      )
                    }
                  >
                    <LinkRounded fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="规则">
                  <IconButton
                    size="small"
                    onClick={() =>
                      navigate(
                        `/rules?project=${encodeURIComponent(project.id)}`,
                      )
                    }
                  >
                    <RuleRounded fontSize="small" />
                  </IconButton>
                </Tooltip>
                {policy && (
                  <Tooltip title="出口">
                    <IconButton
                      size="small"
                      onClick={() =>
                        navigate(
                          `/proxies?policy=${encodeURIComponent(policy)}`,
                        )
                      }
                    >
                      <LanRounded fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
            </Stack>
          )
        })}
      </Stack>
    </Paper>
  )
}

export default RoutingRelationsPanel
