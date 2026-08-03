import {
  AddRounded,
  AppsRounded,
  CheckRounded,
  RefreshRounded,
} from '@mui/icons-material'
import {
  Alert,
  Avatar,
  Box,
  CircularProgress,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  getSystemProcessConnections,
  type ProcessConnectionSnapshot,
} from '@/services/process-connections'

import type { DiversionProject } from './model'

export interface DetectedProgram {
  key: string
  name: string
  path: string
  pids: number[]
  connectionCount: number
  protocols: string[]
}

interface DetectedProgramsPanelProps {
  projects: DiversionProject[]
  onImport: (program: DetectedProgram) => void
}

export const DetectedProgramsPanel = ({
  projects,
  onImport,
}: DetectedProgramsPanelProps) => {
  const [snapshot, setSnapshot] = useState<ProcessConnectionSnapshot>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const nextSnapshot = await getSystemProcessConnections()
      setSnapshot(nextSnapshot)
      if (nextSnapshot.errors.length > 0) {
        setError(nextSnapshot.errors.join('；'))
      }
    } catch (reason) {
      setError(String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const programs = useMemo(() => {
    const grouped = new Map<string, DetectedProgram>()

    for (const connection of snapshot?.connections ?? []) {
      const path = connection.processPath.trim()
      const name = connection.processName.trim() || `PID ${connection.pid}`
      const key = path.toLowerCase() || name.toLowerCase()
      const current = grouped.get(key) ?? {
        key,
        name,
        path,
        pids: [],
        connectionCount: 0,
        protocols: [],
      }

      current.connectionCount += 1
      if (!current.pids.includes(connection.pid)) {
        current.pids.push(connection.pid)
      }
      if (!current.protocols.includes(connection.protocol)) {
        current.protocols.push(connection.protocol)
      }
      grouped.set(key, current)
    }

    return [...grouped.values()]
      .sort(
        (left, right) =>
          right.connectionCount - left.connectionCount ||
          left.name.localeCompare(right.name),
      )
      .slice(0, 24)
  }, [snapshot])

  const registeredPaths = useMemo(
    () =>
      new Set(
        projects.flatMap((project) =>
          project.processPaths.map((path) => path.trim().toLowerCase()),
        ),
      ),
    [projects],
  )
  const registeredNames = useMemo(
    () =>
      new Set(
        projects.flatMap((project) =>
          project.processNames.map((name) => name.trim().toLowerCase()),
        ),
      ),
    [projects],
  )

  return (
    <Paper variant="outlined" sx={{ borderRadius: 2.5, overflow: 'hidden' }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ px: 1.5, py: 1.25, alignItems: 'center' }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'baseline' }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              联网应用
            </Typography>
            {snapshot?.supported && (
              <Typography variant="caption" color="text.secondary">
                {programs.length} 个
              </Typography>
            )}
          </Stack>
          <Typography variant="body2" color="text.secondary" noWrap>
            识别当前联网应用，并为其设置出口策略。
          </Typography>
        </Box>
        <Tooltip title="刷新">
          <span>
            <IconButton
              size="small"
              onClick={() => void refresh()}
              disabled={loading}
            >
              {loading ? (
                <CircularProgress size={18} />
              ) : (
                <RefreshRounded fontSize="small" />
              )}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {snapshot && !snapshot.supported && (
        <Alert severity="info" sx={{ borderRadius: 0 }}>
          {snapshot.source}
        </Alert>
      )}
      {error && (
        <Alert severity="warning" sx={{ borderRadius: 0 }}>
          部分连接无法读取：{error}
        </Alert>
      )}

      {loading && !snapshot ? (
        <Box sx={{ display: 'grid', placeItems: 'center', py: 4 }}>
          <CircularProgress size={24} />
        </Box>
      ) : snapshot?.supported && programs.length === 0 ? (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ px: 1.5, pb: 1.5 }}
        >
          暂未发现可归因连接。
        </Typography>
      ) : programs.length > 0 ? (
        <>
          <Divider />
          <List disablePadding sx={{ maxHeight: 360, overflowY: 'auto' }}>
            {programs.map((program, index) => {
              const registered = program.path
                ? registeredPaths.has(program.path.toLowerCase())
                : registeredNames.has(program.name.toLowerCase())
              const protocolLabel = program.protocols.join(' / ')
              const processLabel =
                program.pids.length > 1
                  ? `${program.pids.length} 个进程`
                  : '1 个进程'

              return (
                <Box key={program.key}>
                  {index > 0 && <Divider component="li" />}
                  <ListItem
                    secondaryAction={
                      <Tooltip title={registered ? '已设置' : '创建应用规则'}>
                        <span>
                          <IconButton
                            edge="end"
                            size="small"
                            color={registered ? 'success' : 'primary'}
                            disabled={registered}
                            onClick={() => onImport(program)}
                          >
                            {registered ? (
                              <CheckRounded fontSize="small" />
                            ) : (
                              <AddRounded fontSize="small" />
                            )}
                          </IconButton>
                        </span>
                      </Tooltip>
                    }
                    sx={{ pr: 6, py: 0.9 }}
                  >
                    <ListItemAvatar sx={{ minWidth: 46 }}>
                      <Avatar
                        variant="rounded"
                        sx={{ width: 34, height: 34, bgcolor: 'action.hover' }}
                      >
                        <AppsRounded fontSize="small" color="primary" />
                      </Avatar>
                    </ListItemAvatar>
                    <ListItemText
                      primary={program.name}
                      secondary={
                        <>
                          <Typography
                            component="span"
                            variant="caption"
                            color="text.secondary"
                            sx={{
                              display: 'block',
                              maxWidth: 760,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {program.path || '受保护的系统进程'}
                          </Typography>
                          <Typography
                            component="span"
                            variant="caption"
                            color="text.secondary"
                          >
                            {`${program.connectionCount} 条连接 · ${processLabel}${protocolLabel ? ` · ${protocolLabel}` : ''}`}
                          </Typography>
                        </>
                      }
                      slotProps={{
                        primary: { noWrap: true, sx: { fontWeight: 650 } },
                      }}
                    />
                  </ListItem>
                </Box>
              )
            })}
          </List>
        </>
      ) : null}
    </Paper>
  )
}

export default DetectedProgramsPanel
