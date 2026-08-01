import {
  AddRounded,
  AppsRounded,
  DeleteOutlineRounded,
  EditRounded,
  HubRounded,
  LanRounded,
  WorkspacesRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Switch,
  Typography,
} from '@mui/material'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { actionLabel } from './action-label'
import {
  resolveActionPolicy,
  type DiversionConfig,
  type DiversionProject,
} from './model'
import ProjectEditorDialog from './project-editor-dialog'

interface ProjectPanelProps {
  config: DiversionConfig
  focusProjectId?: string | null
  onChange: (patch: Partial<DiversionConfig>) => void
}

const conditionCount = (project: DiversionProject) =>
  project.processNames.length +
  project.processPaths.length +
  project.domains.length +
  project.ipCidrs.length +
  project.destinationPorts.length

export const ProjectPanel = ({
  config,
  focusProjectId,
  onChange,
}: ProjectPanelProps) => {
  const navigate = useNavigate()
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<DiversionProject | null>(
    null,
  )
  const focusedOnce = useRef<string | null>(null)

  useEffect(() => {
    if (!focusProjectId || focusedOnce.current === focusProjectId) return
    const project = config.projects.find((item) => item.id === focusProjectId)
    if (!project) return
    focusedOnce.current = focusProjectId
    setEditingProject(project)
    setEditorOpen(true)
  }, [config.projects, focusProjectId])

  const openCreate = () => {
    setEditingProject(null)
    setEditorOpen(true)
  }

  const openEdit = (project: DiversionProject) => {
    setEditingProject(project)
    setEditorOpen(true)
  }

  const saveProject = (project: DiversionProject) => {
    const exists = config.projects.some((item) => item.id === project.id)
    const projects = exists
      ? config.projects.map((item) => (item.id === project.id ? project : item))
      : [...config.projects, project]
    onChange({ enabled: true, projects })
    setEditorOpen(false)
    setEditingProject(null)
  }

  const deleteProject = (project: DiversionProject) => {
    onChange({
      projects: config.projects.filter((item) => item.id !== project.id),
    })
  }

  const toggleProject = (project: DiversionProject, enabled: boolean) => {
    onChange({
      projects: config.projects.map((item) =>
        item.id === project.id ? { ...item, enabled } : item,
      ),
    })
  }

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ mb: 1, alignItems: { sm: 'center' } }}
      >
        <Box sx={{ flex: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            程序与项目档案
          </Typography>
          <Typography variant="caption" color="text.secondary">
            将程序路径、域名、IP
            和端口绑定到同一个规则组与出口；连接、规则和代理组页面会共享这份关系。
          </Typography>
        </Box>
        <Button startIcon={<AddRounded />} onClick={openCreate}>
          添加程序或项目
        </Button>
      </Stack>

      {config.projects.length === 0 ? (
        <Alert severity="info">
          还没有程序或项目档案。Mihomo 无法返回进程信息时，添加域名、IP
          或端口特征仍可识别连接并应用分流。
        </Alert>
      ) : (
        <Stack spacing={1}>
          {config.projects.map((project) => {
            const policy = resolveActionPolicy(
              config,
              project.action,
              project.policy,
            )
            const focused = project.id === focusProjectId
            return (
              <Paper
                key={project.id}
                variant="outlined"
                sx={{
                  p: 1.5,
                  borderRadius: 2,
                  borderColor: focused ? 'primary.main' : 'divider',
                  bgcolor: focused ? 'action.selected' : undefined,
                }}
              >
                <Stack
                  direction={{ xs: 'column', md: 'row' }}
                  spacing={1.5}
                  sx={{ alignItems: { md: 'center' } }}
                >
                  <Box
                    sx={{
                      width: 42,
                      height: 42,
                      display: 'grid',
                      placeItems: 'center',
                      borderRadius: 2,
                      bgcolor: project.enabled
                        ? 'primary.main'
                        : 'action.hover',
                      color: project.enabled
                        ? 'primary.contrastText'
                        : 'text.secondary',
                    }}
                  >
                    {project.kind === 'program' ? (
                      <AppsRounded />
                    ) : (
                      <WorkspacesRounded />
                    )}
                  </Box>

                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 700 }}>
                      {project.name}
                    </Typography>
                    {project.description && (
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ wordBreak: 'break-word' }}
                      >
                        {project.description}
                      </Typography>
                    )}
                    <Stack
                      direction="row"
                      spacing={0.75}
                      sx={{ mt: 0.75, flexWrap: 'wrap' }}
                    >
                      <Chip
                        size="small"
                        label={`${conditionCount(project)} 个识别条件`}
                      />
                      <Chip
                        size="small"
                        color="primary"
                        variant="outlined"
                        label={actionLabel(project.action, project.policy)}
                      />
                      <Chip
                        size="small"
                        icon={<HubRounded />}
                        label={`规则组：${project.groupId}`}
                      />
                      {policy && (
                        <Chip
                          size="small"
                          icon={<LanRounded />}
                          label={`出口：${policy}`}
                        />
                      )}
                    </Stack>
                  </Box>

                  <Switch
                    checked={project.enabled}
                    onChange={(_, checked) => toggleProject(project, checked)}
                    inputProps={{ 'aria-label': `启用 ${project.name}` }}
                  />

                  <Stack
                    direction="row"
                    spacing={0.5}
                    sx={{ flexWrap: 'wrap' }}
                  >
                    <Button
                      size="small"
                      onClick={() =>
                        navigate(
                          `/connections?project=${encodeURIComponent(project.id)}`,
                        )
                      }
                    >
                      查看连接
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
                        查看代理组
                      </Button>
                    )}
                    <Button
                      size="small"
                      startIcon={<EditRounded />}
                      onClick={() => openEdit(project)}
                    >
                      编辑
                    </Button>
                    <Button
                      size="small"
                      color="error"
                      startIcon={<DeleteOutlineRounded />}
                      onClick={() => deleteProject(project)}
                    >
                      删除
                    </Button>
                  </Stack>
                </Stack>
              </Paper>
            )
          })}
        </Stack>
      )}

      <ProjectEditorDialog
        open={editorOpen}
        project={editingProject}
        projectIndex={config.projects.length}
        onClose={() => {
          setEditorOpen(false)
          setEditingProject(null)
        }}
        onSave={saveProject}
      />
    </Box>
  )
}

export default ProjectPanel
