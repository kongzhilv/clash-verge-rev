import {
  AppsRounded,
  ArrowDownwardRounded,
  ArrowUpwardRounded,
  CloseRounded,
  ExpandMoreRounded,
  LanRounded,
  PowerOffRounded,
  RouteRounded,
  ScheduleRounded,
  SpeedRounded,
  TuneRounded,
} from '@mui/icons-material'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Divider,
  Drawer,
  IconButton,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import dayjs from 'dayjs'
import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import { useTranslation } from 'react-i18next'
import { closeConnection } from 'tauri-plugin-mihomo-api'

import ConnectionProjectCard from '@/components/routing/connection-project-card'
import { resolveConnectionProject } from '@/components/routing/connection-project'
import {
  useConnectionData,
  useConnectionProcessAttribution,
} from '@/hooks/use-connection-data'
import { useDiversionProfile } from '@/hooks/use-diversion-profile'
import parseTraffic from '@/utils/parse-traffic'

import ConnectionRuleAssistant from './connection-rule-assistant'

export interface ConnectionDetailRef {
  open: (detail: IConnectionsItem, closed: boolean) => void
  close: () => void
}

const processNameFrom = (process: string, processPath: string) => {
  const preferred = process.trim()
  if (preferred) return preferred
  return processPath.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}

export function ConnectionDetail({ ref }: { ref?: Ref<ConnectionDetailRef> }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<IConnectionsItem | null>(null)
  const [initiallyClosed, setInitiallyClosed] = useState(false)
  const [ruleAssistantOpen, setRuleAssistantOpen] = useState(false)
  const {
    response: { data: connectionData },
  } = useConnectionData({ enabled: open })

  const activeDetail = useMemo(
    () =>
      selected
        ? connectionData.activeConnections.find(
            (connection) => connection.id === selected.id,
          )
        : undefined,
    [connectionData.activeConnections, selected],
  )
  const closedDetail = useMemo(
    () =>
      selected
        ? connectionData.closedConnections.find(
            (connection) => connection.id === selected.id,
          )
        : undefined,
    [connectionData.closedConnections, selected],
  )
  const detail = activeDetail ?? closedDetail ?? selected
  const closed = initiallyClosed || (!activeDetail && Boolean(closedDetail))

  const onClose = useCallback(() => {
    setOpen(false)
    setRuleAssistantOpen(false)
    setSelected(null)
    setInitiallyClosed(false)
  }, [])

  useImperativeHandle(ref, () => ({
    open: (nextDetail: IConnectionsItem, nextClosed: boolean) => {
      setSelected(nextDetail)
      setInitiallyClosed(nextClosed)
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
              width: { xs: '100%', sm: 520 },
              maxWidth: '100vw',
              height: '100%',
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

interface MetricProps {
  label: string
  value: string
  icon: ReactNode
}

const Metric = ({ label, value, icon }: MetricProps) => (
  <Box sx={{ minWidth: 0, p: 1.25 }}>
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      <Box sx={{ color: 'text.secondary', display: 'flex' }}>{icon}</Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
    <Typography sx={{ mt: 0.5, fontWeight: 700 }} noWrap>
      {value}
    </Typography>
  </Box>
)

const InnerConnectionDetail = ({
  data,
  closed,
  onClose,
  onOpenRuleAssistant,
}: InnerProps) => {
  const { t } = useTranslation()
  const { profile } = useDiversionProfile()
  const attribution = useConnectionProcessAttribution(data.id)
  const projectMatch = useMemo(
    () => resolveConnectionProject(data, profile?.config),
    [data, profile?.config],
  )
  const { metadata } = data
  const hostAddress =
    metadata.host || metadata.destinationIP || metadata.remoteDestination
  const destination = metadata.destinationIP || metadata.remoteDestination
  const processPath = String(metadata.processPath ?? '').trim()
  const processName = processNameFrom(
    String(metadata.process ?? ''),
    processPath,
  )
  const applicationName =
    processName || projectMatch?.project.name || '未识别应用'
  const targetLabel = hostAddress
    ? `${hostAddress}:${metadata.destinationPort}`
    : '未知目标'
  const rule = data.rulePayload
    ? `${data.rule} (${data.rulePayload})`
    : data.rule || '未返回'
  const outbound = [...data.chains].reverse().join(' / ') || '未返回'
  const attributionDetail = attribution
    ? `${attribution.detail}${attribution.pid === undefined ? '' : ` · PID ${attribution.pid}`}`
    : '正在等待应用识别'
  const headerMeta = [
    targetLabel,
    String(metadata.network || '').toUpperCase(),
    metadata.type,
    closed ? '已结束' : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const information: InformationItem[] = [
    {
      label: '应用识别',
      value: attributionDetail,
      icon: <AppsRounded fontSize="small" />,
    },
    ...(processPath
      ? [
          {
            label: '程序路径',
            value: processPath,
            icon: <AppsRounded fontSize="small" />,
          },
        ]
      : []),
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
      label: '命中规则',
      value: rule,
      icon: <RouteRounded fontSize="small" />,
    },
    {
      label: '出口链',
      value: outbound,
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
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          px: 2,
          py: 1.25,
          flex: '0 0 auto',
          alignItems: 'center',
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Box
          sx={{
            width: 40,
            height: 40,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 2,
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
          }}
        >
          <AppsRounded />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }} noWrap>
            {applicationName}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap>
            {headerMeta}
          </Typography>
        </Box>
        <IconButton onClick={onClose} aria-label="关闭连接详情">
          <CloseRounded />
        </IconButton>
      </Stack>

      <Stack
        spacing={1.25}
        sx={{
          p: 1.5,
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
        }}
      >
        <ConnectionProjectCard connection={data} />

        <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              '& > :nth-of-type(odd)': {
                borderRight: 1,
                borderColor: 'divider',
              },
              '& > :nth-of-type(-n+2)': {
                borderBottom: 1,
                borderColor: 'divider',
              },
            }}
          >
            <Metric
              label={t('shared.labels.downloaded')}
              value={parseTraffic(data.download).join(' ')}
              icon={<ArrowDownwardRounded fontSize="small" />}
            />
            <Metric
              label={t('shared.labels.uploaded')}
              value={parseTraffic(data.upload).join(' ')}
              icon={<ArrowUpwardRounded fontSize="small" />}
            />
            <Metric
              label={t('connections.components.fields.dlSpeed')}
              value={`${parseTraffic(data.curDownload ?? -1).join(' ')}/s`}
              icon={<SpeedRounded fontSize="small" />}
            />
            <Metric
              label={t('connections.components.fields.ulSpeed')}
              value={`${parseTraffic(data.curUpload ?? -1).join(' ')}/s`}
              icon={<SpeedRounded fontSize="small" />}
            />
          </Box>
        </Paper>

        <Accordion
          disableGutters
          elevation={0}
          sx={{
            border: 1,
            borderColor: 'divider',
            borderRadius: '8px !important',
            overflow: 'hidden',
            '&::before': { display: 'none' },
          }}
        >
          <AccordionSummary expandIcon={<ExpandMoreRounded />}>
            <Typography variant="subtitle2">技术详情</Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ p: 0 }}>
            <Stack divider={<Divider flexItem />}>
              {information.map((item) => (
                <Stack
                  key={item.label}
                  direction="row"
                  spacing={1}
                  sx={{ px: 1.5, py: 1, alignItems: 'center' }}
                >
                  <Box sx={{ color: 'text.secondary', display: 'flex' }}>
                    {item.icon}
                  </Box>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ minWidth: 72 }}
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
          </AccordionDetails>
        </Accordion>
      </Stack>

      <Stack
        direction="row"
        spacing={1}
        sx={{
          p: 1.5,
          flex: '0 0 auto',
          alignItems: 'center',
          borderTop: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Button
          variant="contained"
          startIcon={<TuneRounded />}
          onClick={onOpenRuleAssistant}
          sx={{ flex: 1 }}
        >
          调整分流
        </Button>
        {!closed && (
          <Button
            variant="text"
            color="error"
            startIcon={<PowerOffRounded />}
            onClick={() => {
              void onDelete()
              onClose()
            }}
          >
            断开
          </Button>
        )}
      </Stack>
    </Stack>
  )
}
