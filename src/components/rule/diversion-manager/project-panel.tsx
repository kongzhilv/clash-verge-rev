import {
  AddRounded,
  AppsRounded,
  DeleteOutlineRounded,
  EditRounded,
  HubRounded,
  LanRounded,
  LinkRounded,
  WorkspacesRounded,
} from '@mui/icons-material'
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  IconButton,
  Paper,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { actionLabel } from './action-label'
import DetectedProgramsPanel, {
  type DetectedProgram,
} from './detected-programs-panel'
import {
  makeProject,
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
  const [manualEditorOpen, setManualEditorOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<DiversionProject | null>(
    null,
  )
  const [dismissedFocusProjectId, setDismissedFocusProjectId] = useState<
    string | null
  >(null)
  const focusedProject =
    focusProjectId && dismissedFocusProjectId !== focusProjectId
      ? (config.projects.find((item) => item.id === focusProjectId) ?? null)
      : null
  const editorOpen = manualEditorOpen || Boolean(focusedProject)
  const editorProject = manualEditorOpen ? editingProject : focusedProject

  const openCreate = () => {
    setEditingProject(null)
    setManualEditorOpen(true)
  }

  const openEdit = (project: DiversionProject) => {
    setEditingProject(project)
    setManualEditorOpen(true)
  }

  const importDetectedProgram = (program: DetectedProgram) => {
    const processName = program.name.trim()
    const processPath = program.path.trim()
    setEditingProject(
      makeProject(config.projects.length, {
        kind: 'program',
        name: processName.replace(/\.exe$/i, '') || processName,
        description: `系统发现 · ${program.connectionCount} 条连接`,
        processNames: processName ? [processName] : [],
        processPaths: processPath ? [processPath] : [],
      }),
    )
    setManualEditorOpen(true)
  }

  const saveProject = (project: DiversionProject) => {
    const exists = config.projects.some((item) => item.id === project.id)
    const projects = exists
      ? config.projects.map((item) => (item.id === project.id ? project : item))
      : [...config.projects, project]
    onChange({ enabled: true, projects })
    setManualEditorOpen(false)
    setEditingProject(null)
    setDismissedFocusProjectId(focusProjectId ?? null)
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
    <Stack spacing={2}>
      <DetectedProgramsPanel
        projects={config.projects}
        onImport={importDetectedProgram}
      />

      <Box>
        <Stack
          direction="row"
          spacing={1}
          sx={{ mb: 1.25, alignItems: 'center' }}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              项目
            </Typography>
            <Typography variant="body2" color="text.secondary">
              一个项目对应一组识别条件和一个出口。
            </Typography>
          </Box>
          <Button
            variant="outlined"
            startIcon={<AddRounded />}
            onClick={openCreate}
          >
            新建
          </Button>
        </Stack>

        {config.projects.length === 0 ? (
          <Alert severity="info">从上方选择程序，或新建一个项目。</Alert>
        ) : (
          <Stack spacing={0.75}>
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
                    px: 1.25,
                    py: 1,
                    borderRadius: 2.5,
                    borderColor: focused ? 'primary.main' : 'divider',
                    bgcolor: focused ? 'action.selected' : 'background.paper',
                    transition: 'border-color 120ms ease, background 120ms ease',
                  }}
                >
                  <Stack
                    direction="row"
                    spacing={1.25}
                    sx={{ alignItems: 'center', minWidth: 0 }}
                  >
                    <Avatar
                      variant="rounded"
                      sx={{
                        width: 38,
                        height: 38,
                        bgcolor: project.enabled
                          ? 'primary.main'
                          : 'action.hover',
                        color: project.enabled
                          ? 'primary.contrastText'
                          : 'text.secondary',
                      }}
                    >
                      {project.kind === 'program' ? (
                        <AppsRounded fontSize="small" />
                      ) : (
                        <WorkspacesRounded fontSize="small" />
                      )}
                    </Avatar>

                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Stack
                        direction="row"
                        spacing={0.75}
                        sx={{ alignItems: 'center', minWidth: 0 }}
                      >
                        <Typography sx={{ fontWeight: 700 }} noWrap>
                          {project.name}
                        </Typography>
                        {!project.enabled && (
                          <Chip size="small" label="已停用" variant="outlined" />
                        )}
                      </Stack>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        noWrap
                        title={project.description || project.groupId}
                        sx={{ display: 'block' }}
                      >
                        {project.description || project.groupId}
                      </Typography>
                      <Stack
                        direction="row"
                        spacing={0.5}
                        sx={{ mt: 0.65, flexWrap: 'wrap' }}
                      >
                        <Chip
                          size="small"
                          label={`${conditionCount(project)} 条件`}
                        />
                        <Chip
                          size="small"
                          icon={<HubRounded />}
                          label={project.groupId}
                          variant="outlined"
                        />
                        <Chip
                          size="small"
                          color="primary"
                          variant="outlined"
                          icon={<LanRounded />}
                          label={policy || actionLabel(project.action, project.policy)}
                        />
                      </Stack>
                    </Box>

                    <Switch
                      size="small"
                      checked={project.enabled}
                      onChange={(_, checked) => toggleProject(project, checked)}
                      slotProps={{
                        input: { 'aria-label': `启用 ${project.name}` },
                      }}
                    />

                    <Stack direction="row" spacing={0.25}>
                      <Tooltip title="查看连接">
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
                      {policy && (
                        <Tooltip title={`查看出口：${policy}`}>
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
                      <Tooltip title="编辑">
                        <IconButton
                          size="small"
                          onClick={() => openEdit(project)}
                        >
                          <EditRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="删除">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => deleteProject(project)}
                        >
                          <DeleteOutlineRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </Stack>
                </Paper>
              )
            })}
          </Stack>
        )}
      </Box>

      {editorOpen && (
        <ProjectEditorDialog
          open
          project={editorProject}
          projectIndex={config.projects.length}
          onClose={() => {
            setManualEditorOpen(false)
            setEditingProject(null)
            if (focusedProject) setDismissedFocusProjectId(focusedProject.id)
          }}
          onSave={saveProject}
        />
      )}
    </Stack>
  )
}

export default ProjectPanel
