import {
  AccountTreeRounded,
  AppsRounded,
  ArrowForwardRounded,
  LanRounded,
  LinkRounded,
  MoreVertRounded,
  RuleRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { softScrollAreaSx } from '@/components/base'
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
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [menuProject, setMenuProject] = useState<DiversionProject | null>(null)
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
  const menuPolicy =
    menuProject && profile
      ? resolveActionPolicy(
          profile.config,
          menuProject.action,
          menuProject.policy,
        )
      : ''

  const closeMenu = () => {
    setMenuAnchor(null)
    setMenuProject(null)
  }

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
        尚未建立应用分流。
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
        没有应用分流使用“{policyFilter}”。
      </Alert>
    )
  }

  return (
    <>
      <Paper variant="outlined" sx={{ borderRadius: 2.5, overflow: 'hidden' }}>
        <Stack
          direction="row"
          spacing={1}
          sx={{ px: 1.5, py: 1.15, alignItems: 'center' }}
        >
          <AccountTreeRounded color="primary" fontSize="small" />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 700 }}>
              {policyFilter ? '使用此出口的应用' : '应用分流'}
            </Typography>
            {!compact && (
              <Typography variant="caption" color="text.secondary">
                应用规则 → 当前出口
              </Typography>
            )}
          </Box>
          {!compact && (
            <Button
              size="small"
              startIcon={<AppsRounded fontSize="small" />}
              onClick={() => navigate('/rules?manage=projects')}
            >
              管理
            </Button>
          )}
        </Stack>

        <Divider />
        <Stack
          divider={<Divider flexItem />}
          aria-label="应用规则与出口关系"
          sx={{
            maxHeight: compact ? 240 : 360,
            overflowY: 'auto',
            ...softScrollAreaSx,
          }}
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
                sx={{
                  px: 1.25,
                  py: 1,
                  alignItems: 'flex-start',
                  minWidth: 0,
                }}
              >
                <AppsRounded
                  color={project.enabled ? 'primary' : 'disabled'}
                  fontSize="small"
                  sx={{ flex: '0 0 auto', mt: 0.2 }}
                />
                <Stack sx={{ flex: 1, minWidth: 0 }} spacing={0.35}>
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={0.65}
                    sx={{ minWidth: 0, alignItems: { sm: 'center' } }}
                  >
                    <Typography
                      variant="body2"
                      sx={{
                        minWidth: 0,
                        fontWeight: 650,
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {project.name}
                    </Typography>
                    <ArrowForwardRounded
                      fontSize="inherit"
                      color="disabled"
                      sx={{
                        flex: '0 0 auto',
                        display: { xs: 'none', sm: 'block' },
                      }}
                    />
                    <Stack
                      direction="row"
                      spacing={0.45}
                      sx={{ minWidth: 0, alignItems: 'flex-start' }}
                    >
                      <LanRounded
                        color={policy ? 'primary' : 'disabled'}
                        sx={{ fontSize: 16, flex: '0 0 auto', mt: 0.05 }}
                      />
                      <Typography
                        variant="caption"
                        color={policy ? 'primary.main' : 'text.secondary'}
                        sx={{
                          minWidth: 0,
                          fontWeight: 600,
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {policy || '无出口'}
                      </Typography>
                    </Stack>
                  </Stack>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ overflowWrap: 'anywhere' }}
                  >
                    {`当前命中 ${matchedConnections} 条连接${policy ? ` · 此出口共 ${policyConnections} 条` : ''}`}
                  </Typography>
                </Stack>
                <Chip
                  size="small"
                  label={matchedConnections}
                  aria-label={`${project.name} 当前连接数 ${matchedConnections}`}
                />
                <Tooltip title="更多操作">
                  <IconButton
                    size="small"
                    aria-label={`${project.name} 更多操作`}
                    onClick={(event) => {
                      setMenuAnchor(event.currentTarget)
                      setMenuProject(project)
                    }}
                    sx={{ mt: -0.35 }}
                  >
                    <MoreVertRounded fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            )
          })}
        </Stack>
      </Paper>

      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor && menuProject)}
        onClose={closeMenu}
      >
        <MenuItem
          onClick={() => {
            const project = menuProject
            closeMenu()
            if (project) {
              navigate(`/connections?project=${encodeURIComponent(project.id)}`)
            }
          }}
        >
          <ListItemIcon>
            <LinkRounded fontSize="small" />
          </ListItemIcon>
          <ListItemText>查看连接</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            const project = menuProject
            closeMenu()
            if (project) {
              navigate(`/rules?project=${encodeURIComponent(project.id)}`)
            }
          }}
        >
          <ListItemIcon>
            <RuleRounded fontSize="small" />
          </ListItemIcon>
          <ListItemText>编辑应用分流</ListItemText>
        </MenuItem>
        {menuPolicy && (
          <MenuItem
            onClick={() => {
              const policy = menuPolicy
              closeMenu()
              navigate(`/proxies?policy=${encodeURIComponent(policy)}`)
            }}
          >
            <ListItemIcon>
              <LanRounded fontSize="small" />
            </ListItemIcon>
            <ListItemText>打开出口</ListItemText>
          </MenuItem>
        )}
      </Menu>
    </>
  )
}

export default RoutingRelationsPanel
