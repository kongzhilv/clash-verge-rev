import {
  AccountTreeRounded,
  CloseRounded,
  CloudDownloadRounded,
  CloudUploadRounded,
  DeleteForeverRounded,
  TableChartRounded,
  TableRowsRounded,
  ViewColumnRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  ButtonGroup,
  Chip,
  Fab,
  IconButton,
  MenuItem,
  Stack,
  Tooltip,
  Zoom,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import { closeAllConnections } from 'tauri-plugin-mihomo-api'

import {
  BaseEmpty,
  BasePage,
  BaseSearchBox,
  BaseStyledSelect,
  type SearchState,
  VirtualList,
} from '@/components/base'
import {
  ConnectionDetail,
  type ConnectionDetailRef,
} from '@/components/connection/connection-detail'
import { ConnectionRowItem } from '@/components/connection/connection-row-item'
import {
  getConnectionStartTime,
  useConnectionRowViews,
} from '@/components/connection/connection-row-view'
import { ConnectionTable } from '@/components/connection/connection-table'
import {
  connectionUsesPolicy,
  resolveConnectionProject,
} from '@/components/routing/connection-project'
import { useConnectionData } from '@/hooks/use-connection-data'
import { useConnectionSetting } from '@/hooks/use-connection-setting'
import { useDiversionProfile } from '@/hooks/use-diversion-profile'
import { useTrafficData } from '@/hooks/use-traffic-data'
import { useVisibility } from '@/hooks/use-visibility'
import parseTraffic from '@/utils/parse-traffic'

type OrderFunc = (list: IConnectionsItem[]) => IConnectionsItem[]

const ORDER_OPTIONS = [
  {
    id: 'default',
    labelKey: 'connections.components.order.default',
    fn: (list: IConnectionsItem[]) =>
      list.sort(
        (a, b) => getConnectionStartTime(b) - getConnectionStartTime(a),
      ),
  },
  {
    id: 'uploadSpeed',
    labelKey: 'connections.components.order.uploadSpeed',
    fn: (list: IConnectionsItem[]) =>
      list.sort((a, b) => (b.curUpload ?? 0) - (a.curUpload ?? 0)),
  },
  {
    id: 'downloadSpeed',
    labelKey: 'connections.components.order.downloadSpeed',
    fn: (list: IConnectionsItem[]) =>
      list.sort((a, b) => (b.curDownload ?? 0) - (a.curDownload ?? 0)),
  },
] as const

type OrderKey = (typeof ORDER_OPTIONS)[number]['id']

const orderFunctionMap = ORDER_OPTIONS.reduce<Record<OrderKey, OrderFunc>>(
  (acc, option) => {
    acc[option.id] = option.fn
    return acc
  },
  {} as Record<OrderKey, OrderFunc>,
)

const EMPTY_CONNECTIONS: IConnectionsItem[] = []

const ConnectionsPage = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const pageVisible = useVisibility()
  const { profile } = useDiversionProfile()
  const projectFilter = searchParams.get('project')?.trim() ?? ''
  const policyFilter = searchParams.get('policy')?.trim() ?? ''
  const [match, setMatch] = useState<(input: string) => boolean>(
    () => () => true,
  )
  const [hasSearch, setHasSearch] = useState(false)
  const [curOrderOpt, setCurOrderOpt] = useState<OrderKey>('default')
  const [connectionsType, setConnectionsType] = useState<'active' | 'closed'>(
    'active',
  )

  const {
    response: { data: connections },
    clearClosedConnections,
  } = useConnectionData({ enabled: pageVisible })
  const {
    response: { data: traffic },
  } = useTrafficData({ enabled: pageVisible })

  const [setting, setSetting] = useConnectionSetting()
  const isTableLayout = setting.layout === 'table'
  const [isColumnManagerOpen, setIsColumnManagerOpen] = useState(false)

  const selectedConnections =
    connectionsType === 'active'
      ? (connections?.activeConnections ?? EMPTY_CONNECTIONS)
      : (connections?.closedConnections ?? EMPTY_CONNECTIONS)

  const projectMatches = useMemo(
    () =>
      new Map(
        selectedConnections.map((connection) => [
          connection.id,
          resolveConnectionProject(connection, profile?.config),
        ]),
      ),
    [profile?.config, selectedConnections],
  )

  const activeProject = profile?.config.projects.find(
    (project) => project.id === projectFilter,
  )

  const filterConn = useMemo(() => {
    const orderFunc = orderFunctionMap[curOrderOpt]
    const filtered = selectedConnections.filter((conn) => {
      const projectMatch = projectMatches.get(conn.id)
      if (projectFilter && projectMatch?.project.id !== projectFilter) {
        return false
      }
      if (
        policyFilter &&
        projectMatch?.policy.toLowerCase() !== policyFilter.toLowerCase() &&
        !connectionUsesPolicy(conn, policyFilter)
      ) {
        return false
      }
      if (!hasSearch) return true

      const { host, destinationIP, process, processPath } = conn.metadata
      return (
        match(host || '') ||
        match(destinationIP || '') ||
        match(process || '') ||
        match(processPath || '') ||
        match(projectMatch?.project.name ?? '') ||
        match(projectMatch?.project.description ?? '') ||
        match(projectMatch?.policy ?? '')
      )
    })

    if (isTableLayout && !hasSearch && !projectFilter && !policyFilter) {
      return filtered
    }
    return orderFunc([...filtered])
  }, [
    curOrderOpt,
    hasSearch,
    isTableLayout,
    match,
    policyFilter,
    projectFilter,
    projectMatches,
    selectedConnections,
  ])

  const displayRows = useConnectionRowViews(
    isTableLayout ? EMPTY_CONNECTIONS : filterConn,
  )

  const detailRef = useRef<ConnectionDetailRef>(null!)

  const selectConnectionsType = useCallback(
    (type: 'active' | 'closed') => {
      if (type === connectionsType) return
      detailRef.current?.close()
      setIsColumnManagerOpen(false)
      setConnectionsType(type)
    },
    [connectionsType],
  )

  const showDetailById = useCallback(
    (id: string) => {
      const connection = filterConn.find((item) => item.id === id)
      if (connection) {
        detailRef.current?.open(connection, connectionsType === 'closed')
      }
    },
    [connectionsType, filterConn],
  )

  const onCloseAll = useLockFn(closeAllConnections)

  const handleSearch = useCallback(
    (nextMatch: (content: string) => boolean, state: SearchState) => {
      setMatch(() => nextMatch)
      setHasSearch(state.text.length > 0)
    },
    [],
  )
  const hasTableData = filterConn.length > 0

  return (
    <BasePage
      full
      title={t('connections.page.title')}
      contentStyle={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0,
      }}
      header={
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
          <Chip
            size="small"
            variant="outlined"
            icon={<CloudDownloadRounded />}
            label={parseTraffic(traffic?.downTotal || 0)}
          />
          <Chip
            size="small"
            variant="outlined"
            icon={<CloudUploadRounded />}
            label={parseTraffic(traffic?.upTotal || 0)}
          />
          <Tooltip title="应用规则">
            <IconButton
              size="small"
              onClick={() => navigate('/rules?manage=projects')}
            >
              <AccountTreeRounded fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip
            title={
              isTableLayout
                ? t('shared.actions.listView')
                : t('shared.actions.tableView')
            }
          >
            <IconButton
              size="small"
              onClick={() =>
                setSetting((previous) =>
                  previous?.layout !== 'table'
                    ? { ...previous, layout: 'table' }
                    : { ...previous, layout: 'list' },
                )
              }
            >
              {isTableLayout ? (
                <TableRowsRounded fontSize="small" />
              ) : (
                <TableChartRounded fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
          <Tooltip title={t('shared.actions.closeAll')}>
            <IconButton size="small" color="error" onClick={onCloseAll}>
              <CloseRounded fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      }
    >
      <Box
        sx={{
          px: 1.25,
          py: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          bgcolor: 'background.default',
          userSelect: 'text',
          position: 'sticky',
          top: 0,
          zIndex: 2,
        }}
      >
        <ButtonGroup size="small">
          <Button
            variant={connectionsType === 'active' ? 'contained' : 'outlined'}
            onClick={() => selectConnectionsType('active')}
          >
            {`${t('connections.components.actions.active')} ${connections?.activeConnections.length ?? 0}`}
          </Button>
          <Button
            variant={connectionsType === 'closed' ? 'contained' : 'outlined'}
            onClick={() => selectConnectionsType('closed')}
          >
            {`${t('connections.components.actions.closed')} ${connections?.closedConnections.length ?? 0}`}
          </Button>
        </ButtonGroup>

        {!isTableLayout && (
          <BaseStyledSelect
            value={curOrderOpt}
            onChange={(event) => setCurOrderOpt(event.target.value as OrderKey)}
          >
            {ORDER_OPTIONS.map((option) => (
              <MenuItem key={option.id} value={option.id}>
                <span style={{ fontSize: 14 }}>{t(option.labelKey)}</span>
              </MenuItem>
            ))}
          </BaseStyledSelect>
        )}

        {projectFilter && (
          <Chip
            size="small"
            color="primary"
            label={activeProject?.name ?? projectFilter}
            onDelete={() => navigate('/connections')}
          />
        )}
        {policyFilter && (
          <Chip
            size="small"
            color="secondary"
            label={policyFilter}
            onDelete={() => navigate('/connections')}
          />
        )}

        <Box sx={{ flex: 1, minWidth: 120 }}>
          <BaseSearchBox onSearch={handleSearch} />
        </Box>

        {isTableLayout && hasTableData && (
          <Tooltip title={t('connections.components.columnManager.title')}>
            <IconButton
              size="small"
              aria-label={t('connections.components.columnManager.title')}
              onClick={() => setIsColumnManagerOpen(true)}
            >
              <ViewColumnRounded fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {!hasTableData ? (
        <BaseEmpty />
      ) : isTableLayout ? (
        <ConnectionTable
          connections={filterConn}
          onShowDetail={showDetailById}
          columnManagerOpen={isColumnManagerOpen}
          onCloseColumnManager={() => setIsColumnManagerOpen(false)}
        />
      ) : (
        <VirtualList
          key={`${connectionsType}:${projectFilter}:${policyFilter}`}
          count={displayRows.length}
          estimateSize={64}
          renderItem={(index) => {
            const row = displayRows[index]
            const projectMatch = projectMatches.get(row.id)
            return (
              <ConnectionRowItem
                row={row}
                closed={connectionsType === 'closed'}
                onShowDetail={showDetailById}
                projectName={projectMatch?.project.name}
                projectPolicy={projectMatch?.policy}
                projectInferred={projectMatch?.inferred}
              />
            )
          }}
          style={{
            flex: 1,
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
          }}
        />
      )}
      <ConnectionDetail ref={detailRef} />
      <Zoom
        in={connectionsType === 'closed' && filterConn.length > 0}
        unmountOnExit
      >
        <Fab
          size="medium"
          variant="extended"
          sx={{
            position: 'absolute',
            right: 16,
            bottom: isTableLayout ? 70 : 16,
          }}
          color="primary"
          onClick={() => clearClosedConnections()}
        >
          <DeleteForeverRounded sx={{ mr: 1 }} fontSize="small" />
          {t('shared.actions.clear')}
        </Fab>
      </Zoom>
    </BasePage>
  )
}

export default ConnectionsPage
