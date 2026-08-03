import { RefreshRounded } from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { DiversionProject } from './model'

interface ProcessConnectionInfo {
  pid: number
  processName: string
  processPath: string
  protocol: string
  localAddress: string
  remoteAddress?: string | null
  state?: string | null
}

interface ProcessConnectionSnapshot {
  supported: boolean
  source: string
  connections: ProcessConnectionInfo[]
  errors: string[]
}

export interface DetectedProgram {
  key: string
  name: string
  path: string
  pids: number[]
  connectionCount: number
  protocols: string[]
  remoteAddresses: string[]
}

interface DetectedProgramsPanelProps {
  projects: DiversionProject[]
  onImport: (program: DetectedProgram) => void
}

const getProcessConnections = () =>
  invoke<ProcessConnectionSnapshot>('get_network_interfaces_info', {
    kind: 'process-connections',
  })

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
      const nextSnapshot = await getProcessConnections()
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
        remoteAddresses: [],
      }

      current.connectionCount += 1
      if (!current.pids.includes(connection.pid)) {
        current.pids.push(connection.pid)
      }
      if (!current.protocols.includes(connection.protocol)) {
        current.protocols.push(connection.protocol)
      }
      if (
        connection.remoteAddress &&
        !current.remoteAddresses.includes(connection.remoteAddress)
      ) {
        current.remoteAddresses.push(connection.remoteAddress)
      }
      grouped.set(key, current)
    }

    return [...grouped.values()]
      .sort(
        (left, right) =>
          right.connectionCount - left.connectionCount ||
          left.name.localeCompare(right.name),
      )
      .slice(0, 40)
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
    <Paper variant="outlined" sx={{ p: 1.5, mb: 2, borderRadius: 2 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ alignItems: { sm: 'center' } }}
      >
        <Box sx={{ flex: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            正在联网的程序
          </Typography>
          <Typography variant="caption" color="text.secondary">
            从 Windows 系统 TCP/UDP
            连接表读取 PID、进程名称和完整 exe 路径；导入后会进入同一套程序档案、规则组和出口策略链。
          </Typography>
        </Box>
        <Button
          size="small"
          startIcon={loading ? <CircularProgress size={16} /> : <RefreshRounded />}
          onClick={() => void refresh()}
          disabled={loading}
        >
          刷新连接
        </Button>
      </Stack>

      {snapshot && !snapshot.supported && (
        <Alert severity="info" sx={{ mt: 1 }}>
          {snapshot.source}
        </Alert>
      )}
      {error && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          部分系统连接读取失败：{error}
        </Alert>
      )}
      {loading && !snapshot ? (
        <Box sx={{ display: 'grid', placeItems: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      ) : snapshot?.supported && programs.length === 0 ? (
        <Alert severity="info" sx={{ mt: 1 }}>
          当前没有发现可归因的系统连接。启动目标程序后点击“刷新连接”。
        </Alert>
      ) : (
        <Stack spacing={1} sx={{ mt: programs.length > 0 ? 1.5 : 0 }}>
          {programs.map((program) => {
            const registered = program.path
              ? registeredPaths.has(program.path.toLowerCase())
              : registeredNames.has(program.name.toLowerCase())

            return (
              <Paper
                key={program.key}
                variant="outlined"
                sx={{ p: 1.25, borderRadius: 2 }}
              >
                <Stack
                  direction={{ xs: 'column', md: 'row' }}
                  spacing={1}
                  sx={{ alignItems: { md: 'center' } }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 700 }}>
                      {program.name}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', wordBreak: 'break-all' }}
                    >
                      {program.path ||
                        '系统进程路径受保护，仍可按进程名称建立规则'}
                    </Typography>
                    <Stack
                      direction="row"
                      spacing={0.75}
                      sx={{ mt: 0.75, flexWrap: 'wrap' }}
                    >
                      <Chip size="small" label={`PID ${program.pids.join(', ')}`} />
                      <Chip
                        size="small"
                        label={`${program.connectionCount} 条系统连接`}
                      />
                      {program.protocols.map((protocol) => (
                        <Chip key={protocol} size="small" label={protocol} />
                      ))}
                      {program.remoteAddresses.slice(0, 3).map((address) => (
                        <Chip
                          key={address}
                          size="small"
                          variant="outlined"
                          label={address}
                        />
                      ))}
                    </Stack>
                  </Box>
                  <Button
                    size="small"
                    variant={registered ? 'text' : 'outlined'}
                    disabled={registered}
                    onClick={() => onImport(program)}
                  >
                    {registered ? '已加入档案' : '加入分流档案'}
                  </Button>
                </Stack>
              </Paper>
            )
          })}
        </Stack>
      )}
    </Paper>
  )
}

export default DetectedProgramsPanel
