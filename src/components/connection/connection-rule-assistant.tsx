import {
  AddRounded,
  AppsRounded,
  ChevronRightRounded,
  DeleteOutlineRounded,
  DnsRounded,
  LanRounded,
  OpenInNewRounded,
  RefreshRounded,
  RouterRounded,
  SettingsEthernetRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
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
import { useNavigate } from 'react-router'
import { closeConnection } from 'tauri-plugin-mihomo-api'

import type {
  DiversionConfig,
  DiversionGroup,
  DiversionMatcher,
  MatcherType,
  UnknownRecord,
} from '@/components/rule/diversion-manager/model'
import {
  parseDiversionProfile,
  serializeDiversionProfile,
} from '@/components/rule/diversion-manager/serializer'
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
  }
  if (destinationIP) {
    candidates.push({
      id: candidateKey('IP-CIDR', destinationIP),
      label: '目标 IP',
      description: '按当前目标 IP 添加精确网段规则。',
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
      label: '进程名称',
      description: '按程序文件名匹配，适合同一程序路径可能变化的情况。',
      type: 'PROCESS-NAME',
      value: processName,
      icon: <AppsRounded />,
    })
  }
  if (processPath) {
    candidates.push({
      id: candidateKey('PROCESS-PATH', processPath),
      label: '进程路径',
      description: '只匹配这个完整程序路径。',
      type: 'PROCESS-PATH',
      value: processPath,
      icon: <RouterRounded />,
    })
  }

  return [...new Map(candidates.map((item) => [item.id, item])).values()]
}

export const ConnectionRuleAssistant = ({
  open,
  connection,
  closed,
  onClose,
}: ConnectionRuleAssistantProps) => {
  const navigate = useNavigate()
  const candidates = useMemo(() => buildCandidates(connection), [connection])
  const [selectedId, setSelectedId] = useState('')
  const [snapshot, setSnapshot] = useState<ProfileSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [savingGroupId, setSavingGroupId] = useState<string | null>(null)

  const selectedCandidate =
    candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0]

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
    if (!open) return
    setSelectedId(candidates[0]?.id ?? '')
    void loadProfile()
  }, [candidates, loadProfile, open])

  const saveConfig = useCallback(
    async (nextConfig: DiversionConfig, groupId: string) => {
      if (!snapshot) return
      setSavingGroupId(groupId)
      try {
        const serialized = serializeDiversionProfile(
          snapshot.mergeConfig,
          nextConfig,
        )
        const valid = await saveProfileFile('Merge', serialized.content)
        if (!valid) throw new Error('Mihomo 配置校验未通过，原配置已恢复')

        setSnapshot({
          mergeConfig: serialized.mergeConfig,
          config: nextConfig,
        })

        if (!closed) {
          try {
            await closeConnection(connection.id)
          } catch {
            // The connection may already have closed while the rule was saved.
          }
        }
        showNotice.success(
          closed
            ? '分流规则已保存并立即应用'
            : '分流规则已保存；当前连接已关闭，下次连接会重新匹配',
        )
      } catch (error) {
        showNotice.error(error)
      } finally {
        setSavingGroupId(null)
      }
    },
    [closed, connection.id, snapshot],
  )

  const addToGroup = async (group: DiversionGroup) => {
    if (!snapshot || !selectedCandidate) return

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
    if (!snapshot || !selectedCandidate) return
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

  const openRulesPage = () => {
    onClose()
    navigate('/rules')
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>从连接管理分流规则</DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Alert severity="info" sx={{ borderRadius: 0 }}>
          选择连接中的域名、IP、端口或程序，再把它加入已有规则组，或从已包含它的规则组中删除。
        </Alert>

        <Box sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                当前连接
              </Typography>
              <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
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
                  <Chip size="small" label={`规则：${connection.rule}`} />
                )}
                {connection.rulePayload && (
                  <Chip
                    size="small"
                    label={`内容：${connection.rulePayload}`}
                  />
                )}
                {connection.chains.length > 0 && (
                  <Chip
                    size="small"
                    label={`出口：${[...connection.chains].reverse().join(' / ')}`}
                  />
                )}
              </Stack>
            </Box>
            <Button
              startIcon={<OpenInNewRounded />}
              onClick={openRulesPage}
              sx={{ alignSelf: { md: 'flex-start' } }}
            >
              打开规则页
            </Button>
          </Stack>
        </Box>

        <Divider />

        <Stack direction={{ xs: 'column', md: 'row' }} sx={{ minHeight: 360 }}>
          <Box
            sx={{
              width: { md: 300 },
              borderRight: { md: 1 },
              borderColor: 'divider',
            }}
          >
            <Typography variant="subtitle2" sx={{ px: 2, pt: 2 }}>
              选择要作为规则的内容
            </Typography>
            <List disablePadding>
              {candidates.map((candidate) => (
                <ListItemButton
                  key={candidate.id}
                  selected={candidate.id === selectedCandidate?.id}
                  onClick={() => setSelectedId(candidate.id)}
                >
                  <ListItemIcon>{candidate.icon}</ListItemIcon>
                  <ListItemText
                    primary={candidate.label}
                    secondary={candidate.value}
                    slotProps={{
                      secondary: { sx: { wordBreak: 'break-all' } },
                    }}
                  />
                  <ChevronRightRounded color="disabled" />
                </ListItemButton>
              ))}
            </List>
            {candidates.length === 0 && (
              <Typography sx={{ p: 2, color: 'text.secondary' }}>
                这条连接没有可用于创建规则的域名、IP、端口或进程信息。
              </Typography>
            )}
          </Box>

          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              sx={{ p: 2, alignItems: { sm: 'center' } }}
            >
              <Box sx={{ flex: 1 }}>
                <Typography variant="subtitle2">选择目标规则组</Typography>
                {selectedCandidate && (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {selectedCandidate.description}
                  </Typography>
                )}
              </Box>
              <Button
                startIcon={<RefreshRounded />}
                onClick={() => void loadProfile()}
                disabled={loading || savingGroupId !== null}
              >
                重新读取
              </Button>
              <Button
                variant="contained"
                startIcon={<AddRounded />}
                onClick={() => void createGroup()}
                disabled={
                  !selectedCandidate || loading || savingGroupId !== null
                }
              >
                新建规则组
              </Button>
            </Stack>

            <Divider />

            {loading ? (
              <Stack sx={{ p: 4, alignItems: 'center' }} spacing={1}>
                <CircularProgress size={28} />
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  正在读取 Merge 分流配置…
                </Typography>
              </Stack>
            ) : snapshot?.config.groups.length ? (
              <List disablePadding>
                {snapshot.config.groups.map((group) => {
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
                    >
                      <ListItemIcon>
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
                        secondary={`${group.enabled ? '已启用' : '未启用'} · ${group.matchers.length} 个匹配条件 · ${included ? '点击移除当前条件' : '点击添加当前条件'}`}
                      />
                      <Chip
                        size="small"
                        color={included ? 'error' : 'primary'}
                        variant="outlined"
                        label={included ? '移除' : '添加'}
                      />
                    </ListItemButton>
                  )
                })}
              </List>
            ) : (
              <Box sx={{ p: 3 }}>
                <Typography sx={{ color: 'text.secondary' }}>
                  还没有自定义规则组。点击“新建规则组”，会使用“当前选择”作为默认出口。
                </Typography>
              </Box>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  )
}

export default ConnectionRuleAssistant
