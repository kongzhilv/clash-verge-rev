import {
  AddLinkRounded,
  AppsRounded,
  CloseRounded,
  DnsRounded,
  HubRounded,
  LanRounded,
  RouteRounded,
  ScheduleRounded,
  SwapVertRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  Paper,
  Stack,
  Typography,
  useTheme,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import dayjs from 'dayjs'
import {
  useCallback,
  useImperativeHandle,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import { useTranslation } from 'react-i18next'
import { closeConnection } from 'tauri-plugin-mihomo-api'

import ConnectionProjectCard from '@/components/routing/connection-project-card'
import parseTraffic from '@/utils/parse-traffic'

import ConnectionRuleAssistant from './connection-rule-assistant'

export interface ConnectionDetailRef {
  open: (detail: IConnectionsItem, closed: boolean) => void
  close: () => void
}

const processNameFrom = (process: string, processPath: string) => {
  const preferred = process.trim()
  if (preferred) return preferred
  const parts = processPath.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? ''
}

export function ConnectionDetail({ ref }: { ref?: Ref<ConnectionDetailRef> }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<IConnectionsItem | null>(null)
  const [closed, setClosed] = useState(false)
  const [ruleAssistantOpen, setRuleAssistantOpen] = useState(false)

  const onClose = useCallback(() => {
    setOpen(false)
    setRuleAssistantOpen(false)
    setDetail(null)
    setClosed(false)
  }, [])

  useImperativeHandle(ref, () => ({
    open: (nextDetail: IConnectionsItem, nextClosed: boolean) => {
      setDetail(nextDetail)
      setClosed(nextClosed)
      setRuleAssistantOpen(false)
      setOpen(true)
    },
    close: onClose,
  }))

  return (
    <>
      <Drawer
        anchor="right"
        open={open && !ruleAssistantOpen}
        onClose={onClose}
        slotProps={{
          paper: {
            sx: {
              width: { xs: '100%', sm: 540 },
              maxWidth: '100vw',
              bgcolor: 'background.default',
            },
          },
        }}
      >
        {detail ? (
          <InnerConnectionDetail
            data={detail}
            closed={closed}
            onClose={onClose}
            onOpenRuleAssistant={() => setRuleAssistantOpen(true)}
          />
        ) : null}
      </Drawer>

      {detail && (
        <ConnectionRuleAssistant
          open={open && ruleAssistantOpen}
          connection={detail}
          closed={closed}
          onClose={() => setRuleAssistantOpen(false)}
        />
      )}
    </>
  )
}

interface InnerProps {
  data: IConnectionsItem
  closed: boolean
  onClose: () => void
  onOpenRuleAssistant: () => void
}

interface InformationItem {
  label: string
  value: string
  icon: ReactNode
}

const InnerConnectionDetail = ({
  data,
  closed,
  onClose,
  onOpenRuleAssistant,
}: InnerProps) => {
  const { t } = useTranslation()
  const { metadata, rulePayload } = data
  const theme = useTheme()
  const chains = [...data.chains].reverse().join(' / ')
  const rule = rulePayload ? `${data.rule}(${rulePayload})` : data.rule
  const hostAddress =
    metadata.host || metadata.destinationIP || metadata.remoteDestination
  const host = `${hostAddress}:${metadata.destinationPort}`
  const destination = metadata.destinationIP || metadata.remoteDestination
  const processPath = String(metadata.processPath ?? '').trim()
  const processName = processNameFrom(
    String(metadata.process ?? ''),
    processPath,
  )
  const hasProcess = Boolean(processName || processPath)

  const information: InformationItem[] = [
    {
      label: t('shared.labels.downloaded'),
      value: parseTraffic(data.download).join(' '),
      icon: <SwapVertRounded fontSize="small" />,
    },
    {
      label: t('shared.labels.uploaded'),
      value: parseTraffic(data.upload).join(' '),
      icon: <SwapVertRounded fontSize="small" />,
    },
    {
      label: t('connections.components.fields.dlSpeed'),
      value: `${parseTraffic(data.curDownload ?? -1).join(' ')}/s`,
      icon: <SwapVertRounded fontSize="small" />,
    },
    {
      label: t('connections.components.fields.ulSpeed'),
      value: `${parseTraffic(data.curUpload ?? -1).join(' ')}/s`,
      icon: <SwapVertRounded fontSize="small" />,
    },
    {
      label: t('connections.components.fields.source'),
      value: `${metadata.sourceIP}:${metadata.sourcePort}`,
      icon: <LanRounded fontSize="small" />,
    },
    {
      label: t('connections.components.fields.destination'),
      value: `${destination}:${metadata.destinationPort}`,
      icon: <RouteRounded fontSize="small" />,
    },
    {
      label: t('connections.components.fields.time'),
      value: dayjs(data.start).fromNow(),
      icon: <ScheduleRounded fontSize="small" />,
    },
  ]

  const onDelete = useLockFn(async () => closeConnection(data.id))

  return (
    <Stack sx={{ minHeight: '100%', color: theme.palette.text.primary }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          px: 2,
          py: 1.5,
          alignItems: 'center',
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Box
          sx={{
            width: 42,
            height: 42,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 2,
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
          }}
        >
          <DnsRounded />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }} noWrap>
            {hostAddress || '未知目标'}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap>
            {host}
          </Typography>
        </Box>
        <IconButton onClick={onClose} aria-label="关闭连接详情">
          <CloseRounded />
        </IconButton>
      </Stack>

      <Stack spacing={1.5} sx={{ p: 2, overflowY: 'auto' }}>
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
          <Chip size="small" label={metadata.network || '未知网络'} />
          <Chip size="small" label={metadata.type || '未知类型'} />
          {closed && <Chip size="small" color="default" label="已关闭" />}
        </Stack>

        <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
          <Stack
            direction="row"
            spacing={1.25}
            sx={{ alignItems: 'flex-start' }}
          >
            <Box
              sx={{
                width: 38,
                height: 38,
                flex: '0 0 auto',
                display: 'grid',
                placeItems: 'center',
                borderRadius: 2,
                bgcolor: hasProcess ? 'success.main' : 'action.hover',
                color: hasProcess ? 'success.contrastText' : 'text.secondary',
              }}
            >
              <AppsRounded />
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary">
                Mihomo 进程元数据
              </Typography>
              <Typography sx={{ fontWeight: 700, wordBreak: 'break-all' }}>
                {processName || '未返回程序信息'}
              </Typography>
              {processPath && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ mt: 0.25, wordBreak: 'break-all' }}
                >
                  {processPath}
                </Typography>
              )}
              {!hasProcess && (
                <Typography variant="caption" color="text.secondary">
                  下方仍会尝试用已登记的域名、IP 和端口识别程序或项目。
                </Typography>
              )}
            </Box>
          </Stack>
        </Paper>

        <ConnectionProjectCard connection={data} />

        <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
          <Stack divider={<Divider flexItem />}>
            {information.map((item) => (
              <Stack
                key={item.label}
                direction="row"
                spacing={1.25}
                sx={{ px: 1.5, py: 1.1, alignItems: 'center' }}
              >
                <Box sx={{ color: 'text.secondary', display: 'flex' }}>
                  {item.icon}
                </Box>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ minWidth: 88 }}
                >
                  {item.label}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ flex: 1, textAlign: 'right', wordBreak: 'break-all' }}
                >
                  {item.value}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <HubRounded color="primary" fontSize="small" />
              <Typography variant="subtitle2">实际命中规则与出口</Typography>
            </Stack>
            <Box>
              <Typography variant="caption" color="text.secondary">
                命中规则
              </Typography>
              <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                {rule || '未返回规则信息'}
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">
                出口链
              </Typography>
              <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                {chains || '未返回出口信息'}
              </Typography>
            </Box>
          </Stack>
        </Paper>

        <Button
          variant="contained"
          size="large"
          startIcon={<AddLinkRounded />}
          onClick={onOpenRuleAssistant}
        >
          管理程序项目与分流规则
        </Button>

        {!closed && (
          <Button
            variant="outlined"
            color="error"
            onClick={() => {
              void onDelete()
              onClose()
            }}
          >
            {t('connections.components.actions.closeConnection')}
          </Button>
        )}
      </Stack>
    </Stack>
  )
}
