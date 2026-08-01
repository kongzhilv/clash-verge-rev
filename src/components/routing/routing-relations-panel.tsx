import {
  AccountTreeRounded,
  AppsRounded,
  HubRounded,
  LanRounded,
  LinkRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
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
            onClick={() => navigate('/rules?manage=projects')}
          >
            添加程序或项目
          </Button>
        }
      >
        尚未建立程序/项目、规则组与代理组之间的关系。
      </Alert>
    )
  }

  if (policyFilter && projects.length === 0) {
    return (
      <Alert
        severity="warning"
        action={
          <Button color="inherit" onClick={() => navigate('/proxies')}>
            清除筛选
          </Button>
        }
      >
        没有程序或项目使用代理组“{policyFilter}”。
      </Alert>
    )
  }

  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
      <Stack spacing={1.25}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ alignItems: { sm: 'center' } }}
        >
          <Box sx={{ flex: 1 }}>
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
              <AccountTreeRounded color="primary" fontSize="small" />
              <Typography sx={{ fontWeight: 700 }}>程序项目联动关系</Typography>
            </Stack>
            {!compact && (
              <Typography variant="body2" color="text.secondary">
                每个档案同时关联识别条件、真实规则组、出口代理组和当前连接。
              </Typography>
            )}
          </Box>
          <Button
            size="small"
            startIcon={<AppsRounded />}
            onClick={() => navigate('/rules?manage=projects')}
          >
            管理程序项目
          </Button>
        </Stack>

        <Stack direction="row" spacing={1} sx={{ overflowX: 'auto', pb: 0.5 }}>
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
              <Paper
                key={project.id}
                variant="outlined"
                sx={{ p: 1.25, minWidth: compact ? 260 : 320, borderRadius: 2 }}
              >
                <Stack spacing={0.8}>
                  <Typography sx={{ fontWeight: 700 }} noWrap>
                    {project.name}
                  </Typography>
                  <Stack
                    direction="row"
                    spacing={0.5}
                    sx={{ flexWrap: 'wrap' }}
                  >
                    <Chip
                      size="small"
                      icon={<HubRounded />}
                      label={`规则组 ${project.groupId}`}
                    />
                    {policy && (
                      <Chip
                        size="small"
                        color="primary"
                        variant="outlined"
                        icon={<LanRounded />}
                        label={policy}
                      />
                    )}
                    <Chip
                      size="small"
                      label={`识别连接 ${matchedConnections}`}
                    />
                    <Chip
                      size="small"
                      label={`出口连接 ${policyConnections}`}
                    />
                  </Stack>
                  <Stack direction="row" spacing={0.5}>
                    <Button
                      size="small"
                      startIcon={<LinkRounded />}
                      onClick={() =>
                        navigate(
                          `/connections?project=${encodeURIComponent(project.id)}`,
                        )
                      }
                    >
                      连接
                    </Button>
                    <Button
                      size="small"
                      onClick={() =>
                        navigate(
                          `/rules?project=${encodeURIComponent(project.id)}`,
                        )
                      }
                    >
                      规则
                    </Button>
                    {policy && (
                      <Button
                        size="small"
                        onClick={() =>
                          navigate(
                            `/proxies?policy=${encodeURIComponent(policy)}`,
                          )
                        }
                      >
                        代理组
                      </Button>
                    )}
                  </Stack>
                </Stack>
              </Paper>
            )
          })}
        </Stack>
      </Stack>
    </Paper>
  )
}

export default RoutingRelationsPanel
