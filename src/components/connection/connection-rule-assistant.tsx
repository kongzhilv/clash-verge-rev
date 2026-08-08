import {
  AddRounded,
  AppsRounded,
  ChevronRightRounded,
  CloseRounded,
  DeleteOutlineRounded,
  DnsRounded,
  LanRounded,
  RouterRounded,
  SettingsEthernetRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { closeConnection } from 'tauri-plugin-mihomo-api'

import { AdaptiveDialog } from '@/components/base'
import { resolveConnectionProject } from '@/components/routing/connection-project'
import {
  makeProject,
  type DiversionConfig,
  type DiversionGroup,
  type DiversionMatcher,
  type DiversionProject,
  type MatcherType,
  type UnknownRecord,
} from '@/components/rule/diversion-manager/model'
import ProjectEditorDialog from '@/components/rule/diversion-manager/project-editor-dialog'
import {
  parseDiversionProfile,
  serializeDiversionProfile,
} from '@/components/rule/diversion-manager/serializer'
import { notifyDiversionUpdated } from '@/hooks/use-diversion-profile'
import { readProfileFile, saveProfileFile } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

interface ConnectionRuleAssistantProps {
  open: boolean
  connection: IConnectionsItem
  closed: boolean
  onClose: () => void
}

interface RuleCandidate {
  id: string
  label: string
  description: string
  type: MatcherType
  value: string
  icon: ReactNode
}

interface ProfileSnapshot {
  mergeConfig: UnknownRecord
  config: DiversionConfig
}

const cleanHost = (raw: string) => {
  const value = raw.trim()
  if (!value) return ''
  try {
    const withScheme = value.includes('://') ? value : `https://${value}`
    return new URL(withScheme).hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
  } catch {
    return value.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  }
}

const isIpLiteral = (value: string) =>
  /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || value.includes(':')

const isMihomoFakeIp = (value: string) => {
  const normalized = value
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\/.+$/, '')
    .toLowerCase()
  return (
    normalized.startsWith('198.18.') || normalized.startsWith('fdfe:dcba:9876:')
  )
}

const processNameFrom = (process: string, processPath: string) => {
  const source = process.trim() || processPath.trim()
  const parts = source.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? source
}

const ipCidr = (value: string) => {
  const ip = value.trim().replace(/^\[|\]$/g, '')
  if (!ip || ip.includes('/')) return ip
  return ip.includes(':') ? `${ip}/128` : `${ip}/32`
}

const candidateKey = (type: MatcherType, value: string) => {
  const trimmed = value.trim()
  if (
    type === 'DOMAIN' ||
    type === 'DOMAIN-SUFFIX' ||
    type === 'PROCESS-NAME'
  ) {
    return `${type}:${trimmed.toLowerCase()}`
  }
  return `${type}:${trimmed}`
}

const matcherMatches = (matcher: DiversionMatcher, candidate: RuleCandidate) =>
  candidateKey(matcher.type, matcher.value) ===
  candidateKey(candidate.type, candidate.value)

const matcherForCandidate = (candidate: RuleCandidate): DiversionMatcher => ({
  id: crypto.randomUUID(),
  enabled: true,
  type: candidate.type,
  value: candidate.value,
  ...(candidate.type === 'IP-CIDR' ? { 'no-resolve': true } : {}),
})

const uniqueGroupName = (base: string, groups: DiversionGroup[]) => {
  const names = new Set(groups.map((group) => group.name.trim()))
  if (!names.has(base)) return base
  let index = 2
  while (names.has(`${base} ${index}`)) index += 1
  return `${base} ${index}`
}

const buildCandidates = (connection: IConnectionsItem): RuleCandidate[] => {
  const metadata = connection.metadata
  const host = cleanHost(metadata.host ?? '')
  const destinationIP = ipCidr(
    metadata.destinationIP || metadata.remoteDestination || '',
  )
  const destinationPort = String(metadata.destinationPort ?? '').trim()
  const processPath = String(metadata.processPath ?? '').trim()
  const processName = processNameFrom(
    String(metadata.process ?? ''),
    processPath,
  )

  const candidates: RuleCandidate[] = []
  if (host && !isIpLiteral(host)) {
    candidates.push({
      id: candidateKey('DOMAIN', host),
      label: '完整域名',
      description: '只匹配当前连接显示的这个域名。',
      type: 'DOMAIN',
      value: host,
      icon: <DnsRounded />,
    })
    candidates.push({
      id: candidateKey('DOMAIN-SUFFIX', host),
      label: '域名后缀',
      description: '匹配这个域名及其所有子域名。',
      type: 'DOMAIN-SUFFIX',
      value: host,
      icon: <DnsRounded />,
    })
  }
  if (destinationIP && !isMihomoFakeIp(destinationIP)) {
    candidates.push({
      id: candidateKey('IP-CIDR', destinationIP),
      label: '目标 IP',
      description: '按当前真实目标 IP 添加精确网段规则。',
      type: 'IP-CIDR',
      value: destinationIP,
      icon: <LanRounded />,
    })
  }
  if (destinationPort) {
    candidates.push({
      id: candidateKey('DST-PORT', destinationPort),
      label: '目标端口',
      description: '所有访问这个目标端口的连接都会匹配。',
      type: 'DST-PORT',
      value: destinationPort,
      icon: <SettingsEthernetRounded />,
    })
  }
  if (processName) {
    candidates.push({
      id: candidateKey('PROCESS-NAME', processName),
      label: '应用名称',
      description: '按应用名称匹配，适合同一应用路径可能变化的情况。',
      type: 'PROCESS-NAME',
      value: processName,
      icon: <AppsRounded />,
    })
  }
  if (processPath) {
    candidates.push({
      id: candidateKey('PROCESS-PATH', processPath),
      label: '应用路径',
      description: '只匹配这个应用完整路径。',
      type: 'PROCESS-PATH',
      value: processPath,
      icon: <RouterRounded />,
    })
  }

  return [...new Map(candidates.map((item) => [item.id, item])).values()]
}

const buildProjectFromConnection = (
  connection: IConnectionsItem,
  index: number,
): DiversionProject => {
  const metadata = connection.metadata
  const host = cleanHost(String(metadata.host ?? ''))
  const processPath = String(metadata.processPath ?? '').trim()
  const processName = processNameFrom(
    String(metadata.process ?? ''),
    processPath,
  )
  const destinationIP = ipCidr(
    String(metadata.destinationIP || metadata.remoteDestination || ''),
  )
  const name = processName || host || `应用分流 ${index + 1}`

  return makeProject(index, {
    kind: processName || processPath ? 'program' : 'project',
    name,
    description: '由连接详情创建',
    action: 'current',
    processNames: processName ? [processName] : [],
    processPaths: processPath ? [processPath] : [],
    domains: host && !isIpLiteral(host) ? [host] : [],
    ipCidrs:
      destinationIP && !isMihomoFakeIp(destinationIP) ? [destinationIP] : [],
    destinationPorts: [],
  })
}

export const ConnectionRuleAssistant = ({
  open,
  connection,
  closed,
  onClose,
}: ConnectionRuleAssistantProps) => {
  const candidates = useMemo(() => buildCandidates(connection), [connection])
  const [selectedId, setSelectedId] = useState('')
  const [snapshot, setSnapshot] = useState<ProfileSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [savingGroupId, setSavingGroupId] = useState<string | null>(null)
  const [projectEditorOpen, setProjectEditorOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<DiversionProject | null>(
    null,
  )

  const selectedCandidate =
    candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0]
  const linkedProject = useMemo(
    () =>
      resolveConnectionProject(connection, snapshot?.config)?.project ?? null,
    [connection, snapshot?.config],
  )

  const loadProfile = useCallback(async () => {
    setLoading(true)
    try {
      const content = await readProfileFile('Merge')
      const parsed = parseDiversionProfile(content)
      setSnapshot(parsed)
    } catch (error) {
      showNotice.error(error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void loadProfile()
  }, [loadProfile, open])

  const saveConfig = useCallback(
    async (nextConfig: DiversionConfig, operationId: string) => {
      if (!snapshot) return false
      setSavingGroupId(operationId)
      try {
        const serialized = serializeDiversionProfile(
          snapshot.mergeConfig,
          nextConfig,
        )
        const valid = await saveProfileFile('Merge', serialized.content)
        if (!valid) throw new Error('Mihomo 配置校验未通过，原配置已恢复')

        setSnapshot({
          mergeConfig: serialized.mergeConfig,
          config: serialized.config,
        })
        notifyDiversionUpdated(serialized.config)

        if (!closed) {
          try {
            await closeConnection(connection.id)
          } catch {
            // The connection may already have closed while the rule was saved.
          }
        }
        showNotice.success(
          closed
            ? '分流设置已保存并立即应用'
            : '分流设置已保存；当前连接已关闭，下次连接会重新匹配',
        )
        return true
      } catch (error) {
        showNotice.error(error)
        return false
      } finally {
        setSavingGroupId(null)
      }
    },
    [closed, connection.id, snapshot],
  )

  const addToGroup = async (group: DiversionGroup) => {
    if (!snapshot || !selectedCandidate || group['project-id']) return

    const groups = snapshot.config.groups.map((item) => {
      if (item.id !== group.id) return item
      const existing = item.matchers.some((matcher) =>
        matcherMatches(matcher, selectedCandidate),
      )
      const matchers = existing
        ? item.matchers.map((matcher) =>
            matcherMatches(matcher, selectedCandidate)
              ? { ...matcher, enabled: true }
              : matcher,
          )
        : [...item.matchers, matcherForCandidate(selectedCandidate)]

      return {
        ...item,
        enabled: true,
        action: item.action === 'none' ? ('current' as const) : item.action,
        matchers,
      }
    })
    await saveConfig({ ...snapshot.config, enabled: true, groups }, group.id)
  }

  const removeFromGroup = async (group: DiversionGroup) => {
    if (!snapshot || !selectedCandidate || group['project-id']) return
    const groups = snapshot.config.groups.map((item) => {
      if (item.id !== group.id) return item
      const matchers = item.matchers.filter(
        (matcher) => !matcherMatches(matcher, selectedCandidate),
      )
      return {
        ...item,
        enabled: matchers.length > 0 ? item.enabled : false,
        matchers,
      }
    })
    await saveConfig({ ...snapshot.config, groups }, group.id)
  }

  const createGroup = async () => {
    if (!snapshot || !selectedCandidate) return
    const baseName = `${selectedCandidate.label} · ${selectedCandidate.value}`
    const id = crypto.randomUUID()
    const group: DiversionGroup = {
      id,
      name: uniqueGroupName(baseName.slice(0, 80), snapshot.config.groups),
      enabled: true,
      logic: 'or',
      action: 'current',
      matchers: [matcherForCandidate(selectedCandidate)],
    }
    await saveConfig(
      {
        ...snapshot.config,
        enabled: true,
        groups: [...snapshot.config.groups, group],
      },
      id,
    )
  }

  const openProjectEditor = () => {
    const project =
      linkedProject ??
      buildProjectFromConnection(
        connection,
        snapshot?.config.projects.length ?? 0,
      )
    setEditingProject(project)
    setProjectEditorOpen(true)
  }

  const saveProject = async (project: DiversionProject) => {
    if (!snapshot) return
    const exists = snapshot.config.projects.some(
      (item) => item.id === project.id,
    )
    const projects = exists
      ? snapshot.config.projects.map((item) =>
          item.id === project.id ? project : item,
        )
      : [...snapshot.config.projects, project]
    const saved = await saveConfig(
      { ...snapshot.config, enabled: true, projects },
      project.groupId,
    )
    if (saved) {
      setProjectEditorOpen(false)
      setEditingProject(null)
    }
  }

  const manualGroups =
    snapshot?.config.groups.filter((group) => !group['project-id']) ?? []

  return (
    <>
      <AdaptiveDialog
        open={open && !projectEditorOpen}
        onClose={onClose}
        maxWidth="md"
        fillDesktopHeight
        aria-labelledby="connection-routing-assistant-title"
      >
        <DialogTitle
          id="connection-routing-assistant-title"
          sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              设置分流
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ overflowWrap: 'anywhere' }}
            >
              为当前应用设置主要出口，或把单个连接特征补充到通用规则。
            </Typography>
          </Box>
          <IconButton onClick={onClose} aria-label="关闭设置分流">
            <CloseRounded />
          </IconButton>
        </DialogTitle>
        <DialogContent
          dividers
          sx={{ p: 0, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
        >
          <Box sx={{ p: 2 }}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                  当前连接
                </Typography>
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  {connection.metadata.host ||
                    connection.metadata.destinationIP ||
                    connection.metadata.remoteDestination ||
                    '未知目标'}
                </Typography>
                <Stack
                  direction="row"
                  spacing={0.75}
                  sx={{ mt: 1, flexWrap: 'wrap' }}
                >
                  {connection.rule && (
                    <Chip
                      size="small"
                      label={`规则：${connection.rule}`}
                      sx={{ maxWidth: '100%' }}
                    />
                  )}
                  {connection.chains.length > 0 && (
                    <Chip
                      size="small"
                      label={`出口：${[...connection.chains].reverse().join(' / ')}`}
                      sx={{ maxWidth: '100%' }}
                    />
                  )}
                  {linkedProject && (
                    <Chip
                      size="small"
                      color="primary"
                      label={linkedProject.name}
                      sx={{ maxWidth: '100%' }}
                    />
                  )}
                </Stack>
              </Box>
              <Button
                variant="contained"
                startIcon={<AppsRounded />}
                onClick={openProjectEditor}
                disabled={loading || savingGroupId !== null}
                sx={{
                  alignSelf: { xs: 'stretch', md: 'flex-start' },
                  flex: '0 0 auto',
                }}
              >
                {linkedProject ? '编辑应用分流' : '设置应用分流'}
              </Button>
            </Stack>
          </Box>

          <Divider />

          <Stack
            direction={{ xs: 'column', md: 'row' }}
            sx={{ minHeight: { md: 360 } }}
          >
            <Box
              sx={{
                width: { md: 300 },
                flex: { md: '0 0 300px' },
                borderRight: { md: 1 },
                borderBottom: { xs: 1, md: 0 },
                borderColor: 'divider',
              }}
            >
              <Typography variant="subtitle2" sx={{ px: 2, pt: 2 }}>
                当前连接特征
              </Typography>
              <List disablePadding>
                {candidates.map((candidate) => (
                  <ListItemButton
                    key={candidate.id}
                    selected={candidate.id === selectedCandidate?.id}
                    onClick={() => setSelectedId(candidate.id)}
                    sx={{ alignItems: 'flex-start' }}
                  >
                    <ListItemIcon sx={{ mt: 0.25 }}>
                      {candidate.icon}
                    </ListItemIcon>
                    <ListItemText
                      primary={candidate.label}
                      secondary={candidate.value}
                      slotProps={{
                        secondary: { sx: { overflowWrap: 'anywhere' } },
                      }}
                    />
                    <ChevronRightRounded color="disabled" />
                  </ListItemButton>
                ))}
              </List>
              {candidates.length === 0 && (
                <Typography sx={{ p: 2, color: 'text.secondary' }}>
                  没有可用的连接特征，仍可为应用设置分流。
                </Typography>
              )}
            </Box>

            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                sx={{ p: 2, alignItems: { sm: 'center' } }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle2">通用规则</Typography>
                  {selectedCandidate && (
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ overflowWrap: 'anywhere' }}
                    >
                      {selectedCandidate.description}
                    </Typography>
                  )}
                </Box>
                <Button
                  variant="outlined"
                  startIcon={<AddRounded />}
                  onClick={() => void createGroup()}
                  disabled={
                    !selectedCandidate || loading || savingGroupId !== null
                  }
                  sx={{ flex: '0 0 auto' }}
                >
                  新建通用规则
                </Button>
              </Stack>

              <Divider />

              {loading ? (
                <Stack sx={{ p: 4, alignItems: 'center' }} spacing={1}>
                  <CircularProgress size={28} />
                  <Typography variant="body2" color="text.secondary">
                    正在读取分流配置…
                  </Typography>
                </Stack>
              ) : manualGroups.length ? (
                <List disablePadding>
                  {manualGroups.map((group) => {
                    const included = Boolean(
                      selectedCandidate &&
                        group.matchers.some(
                          (matcher) =>
                            matcher.enabled &&
                            matcherMatches(matcher, selectedCandidate),
                        ),
                    )
                    const busy = savingGroupId === group.id
                    return (
                      <ListItemButton
                        key={group.id}
                        disabled={!selectedCandidate || savingGroupId !== null}
                        onClick={() =>
                          void (included
                            ? removeFromGroup(group)
                            : addToGroup(group))
                        }
                        sx={{ alignItems: 'flex-start' }}
                      >
                        <ListItemIcon sx={{ mt: 0.25 }}>
                          {busy ? (
                            <CircularProgress size={22} />
                          ) : included ? (
                            <DeleteOutlineRounded color="error" />
                          ) : (
                            <AddRounded color="primary" />
                          )}
                        </ListItemIcon>
                        <ListItemText
                          primary={group.name || '未命名规则组'}
                          secondary={`${group.enabled ? '已启用' : '未启用'} · ${group.matchers.length} 个条件`}
                          slotProps={{
                            primary: { sx: { overflowWrap: 'anywhere' } },
                            secondary: { sx: { overflowWrap: 'anywhere' } },
                          }}
                        />
                        <Chip
                          size="small"
                          color={included ? 'error' : 'primary'}
                          variant="outlined"
                          label={included ? '移除' : '添加'}
                          sx={{ mt: 0.15, flex: '0 0 auto' }}
                        />
                      </ListItemButton>
                    )
                  })}
                </List>
              ) : (
                <Box sx={{ p: 3 }}>
                  <Typography color="text.secondary">
                    暂无通用规则。应用分流适合按整个应用设置出口。
                  </Typography>
                </Box>
              )}
            </Box>
          </Stack>
        </DialogContent>
      </AdaptiveDialog>

      {projectEditorOpen && (
        <ProjectEditorDialog
          open
          project={editingProject}
          projectIndex={snapshot?.config.projects.length ?? 0}
          onClose={() => {
            setProjectEditorOpen(false)
            setEditingProject(null)
          }}
          onSave={(project) => void saveProject(project)}
        />
      )}
    </>
  )
}

export default ConnectionRuleAssistant
