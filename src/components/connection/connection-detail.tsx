import {
  AppsRounded,
  ArrowBackRounded,
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
  IconButton,
  Paper,
  Stack,
  Typography,
  useMediaQuery,
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

import { resolveConnectionProject } from '@/components/routing/connection-project'
import ConnectionProjectCard from '@/components/routing/connection-project-card'
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

const PID_PLACEHOLDER_PATTERN = /^PID\s+\d+$/i
const TWO_PANE_QUERY = '(min-width: 1760px)'
const DETAIL_PANE_WIDTH = 'clamp(420px, 30vw, 520px)'
const DETAIL_CONTENT_MAX_WIDTH = 960

const processNameFrom = (process: string, processPath: string) => {
  const preferred = process.trim()
  if (preferred && !PID_PLACEHOLDER_PATTERN.test(preferred)) return preferred
  return processPath.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}

export function ConnectionDetail({ ref }: { ref?: Ref<ConnectionDetailRef> }) {
  const twoPane = useMediaQuery(TWO_PANE_QUERY)
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
  const detailVisible = open && !ruleAssistantOpen

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
      {detailVisible && detail && (
        <Box
          role="region"
          aria-label="连接详情"
          sx={
            twoPane
              ? {
                  flex: '0 0 auto',
                  width: DETAIL_PANE_WIDTH,
                  minWidth: 0,
                  minHeight: 0,
                  height: '100%',
                  overflow: 'hidden',
                  borderLeft: 1,
                  borderColor: 'divider',
                  bgcolor: 'background.default',
                }
              : {
                  position: 'absolute',
                  inset: 0,
                  zIndex: 4,
                  minWidth: 0,
                  minHeight: 0,
                  display: 'flex',
                  overflow: 'hidden',
                  bgcolor: 'background.default',
                }
          }
        >
          <InnerConnectionDetail
            data={detail}
            closed={closed}
            singlePane={!twoPane}
            onClose={onClose}
            onOpenRuleAssistant={() => setRuleAssistantOpen(true)}
          />
        </Box>
      )}

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
  singlePane: boolean
  onClose: () => void
  onOpenRuleAssistant: () => void
}

interface InformationItem {
  label: string
  value: string
  icon: ReactNode
  monospace?: boolean
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
    <Typography
      sx={{
        mt: 0.5,
        fontWeight: 700,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
      }}
    >
      {value}
    </Typography>
  </Box>
)

const InnerConnectionDetail = ({
  data,
  closed,
  singlePane,
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
  const recognizedApplication = processName || projectMatch?.project.name || ''
  const hasApplication = Boolean(recognizedApplication)
  const applicationName = recognizedApplication || hostAddress || '未知连接'
  const targetLabel = hostAddress
    ? `${hostAddress}:${metadata.destinationPort}`
    : '未知目标'
  const rule = data.rulePayload
    ? `${data.rule} (${data.rulePayload})`
    : data.rule || '未返回'
  const outbound = [...data.chains].reverse().join(' / ') || '未返回'
  const attributionSource =
    attribution?.source === 'mihomo'
      ? '代理核心'
      : attribution?.source === 'windows'
        ? 'Windows 系统'
        : '未识别'
  const attributionDetail = attribution
    ? `${attributionSource} · ${attribution.detail}${
        attribution.pid === undefined ? '' : ` · PID ${attribution.pid}`
      }`
    : '正在等待应用识别'
  const headerMeta = [
    hasApplication ? targetLabel : '应用未识别',
    String(metadata.network || '').toUpperCase(),
    metadata.type,
    closed ? '已结束' : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const information: InformationItem[] = [
    {
      label: '归因状态',
      value: attributionDetail,
      icon: <AppsRounded fontSize="small" />,
    },
    ...(processPath
      ? [
          {
            label: '程序路径',
            value: processPath,
            icon: <AppsRounded fontSize="small" />,
            monospace: true,
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
    <Stack
      sx={{
        flex: '1 1 auto',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        bgcolor: 'background.default',
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          px: 1.5,
          py: 1.25,
          flex: '0 0 auto',
          alignItems: 'flex-start',
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <IconButton
          onClick={onClose}
          aria-label={singlePane ? '返回连接列表' : '关闭连接详情'}
          sx={{ mt: -0.35, ml: -0.5, flex: '0 0 auto' }}
        >
          {singlePane ? <ArrowBackRounded /> : <CloseRounded />}
        </IconButton>
        <Box
          sx={{
            width: 40,
            height: 40,
            mt: 0.15,
            display: 'grid',
            placeItems: 'center',
            flex: '0 0 auto',
            borderRadius: 2,
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
          }}
        >
          {hasApplication ? <AppsRounded /> : <RouteRounded />}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="subtitle1"
            sx={{
              fontWeight: 700,
              lineHeight: 1.35,
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
            }}
          >
            {applicationName}
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              mt: 0.25,
              lineHeight: 1.45,
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
            }}
          >
            {headerMeta}
          </Typography>
        </Box>
      </Stack>

      <Box
        sx={{
          flex: '1 1 0',
          minHeight: 0,
          overflowX: 'hidden',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          scrollbarGutter: 'stable',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <Stack
          spacing={1.25}
          sx={{
            width: '100%',
            maxWidth: DETAIL_CONTENT_MAX_WIDTH,
            mx: 'auto',
            p: 1.5,
          }}
        >
          <ConnectionProjectCard connection={data} />

          <Paper variant="outlined" sx={{ borderRadius: 2 }}>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns:
                  'repeat(auto-fit, minmax(min(160px, 100%), 1fr))',
                '& > *': {
                  borderBottom: 1,
                  borderColor: 'divider',
                },
                '& > :last-child': { borderBottom: 0 },
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
              '&::before': { display: 'none' },
            }}
          >
            <AccordionSummary expandIcon={<ExpandMoreRounded />}>
              <Typography variant="subtitle2">技术详情</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <Stack divider={<Divider flexItem />}>
                {information.map((item) => (
                  <Box
                    key={item.label}
                    sx={{ px: 1.5, py: 1.1, minWidth: 0 }}
                  >
                    <Stack
                      direction="row"
                      spacing={1}
                      sx={{ alignItems: 'center', minWidth: 0 }}
                    >
                      <Box sx={{ color: 'text.secondary', display: 'flex' }}>
                        {item.icon}
                      </Box>
                      <Typography variant="body2" color="text.secondary">
                        {item.label}
                      </Typography>
                    </Stack>
                    <Typography
                      variant="body2"
                      sx={{
                        mt: 0.5,
                        pl: 3.75,
                        minWidth: 0,
                        lineHeight: 1.5,
                        wordBreak: 'break-word',
                        overflowWrap: 'anywhere',
                        fontFamily: item.monospace ? 'monospace' : 'inherit',
                        fontSize: item.monospace ? 12 : undefined,
                      }}
                    >
                      {item.value}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            </AccordionDetails>
          </Accordion>
        </Stack>
      </Box>

      <Box
        sx={{
          flex: '0 0 auto',
          borderTop: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Stack
          direction="row"
          spacing={1}
          sx={{
            width: '100%',
            maxWidth: DETAIL_CONTENT_MAX_WIDTH,
            mx: 'auto',
            p: 1.25,
            flexWrap: 'wrap',
          }}
        >
          <Button
            size="small"
            variant="contained"
            startIcon={<TuneRounded />}
            onClick={onOpenRuleAssistant}
            sx={{ flex: '1 1 220px' }}
          >
            调整分流
          </Button>
          {!closed && (
            <Button
              size="small"
              variant="outlined"
              color="error"
              startIcon={<PowerOffRounded />}
              onClick={() => {
                void onDelete()
                onClose()
              }}
              sx={{ flex: '0 1 auto' }}
            >
              断开连接
            </Button>
          )}
        </Stack>
      </Box>
    </Stack>
  )
}
