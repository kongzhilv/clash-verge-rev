import { CloseRounded } from '@mui/icons-material'
import { IconButton } from '@mui/material'
import { useLockFn } from 'ahooks'
import { memo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { closeConnection } from 'tauri-plugin-mihomo-api'

import { RelativeTime } from './connection-relative-time'
import type { ConnectionRowView } from './connection-row-view'

interface Props {
  row: ConnectionRowView
  closed: boolean
  onShowDetail: (id: string) => void
  projectName?: string
  projectPolicy?: string
  projectInferred?: boolean
}

const itemStyle = {
  boxSizing: 'border-box',
  minHeight: 62,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 44px 8px 12px',
  borderBottom: '1px solid var(--divider-color)',
  position: 'relative',
  overflow: 'hidden',
} as const

const contentStyle = {
  minWidth: 0,
  flex: 1,
  cursor: 'pointer',
  userSelect: 'text',
} as const

const primaryStyle = {
  fontSize: 14,
  fontWeight: 650,
  lineHeight: 1.4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

const secondaryStyle = {
  marginTop: 3,
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  color: 'var(--text-secondary)',
  fontSize: 11,
  lineHeight: 1.4,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
} as const

const secondaryItemStyle = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

const speedStyle = {
  flex: '0 0 auto',
  color: 'var(--text-secondary)',
  fontSize: 11,
  lineHeight: 1.45,
  textAlign: 'right',
  whiteSpace: 'nowrap',
} as const

const actionStyle = {
  position: 'absolute',
  right: 6,
  top: '50%',
  transform: 'translateY(-50%)',
} as const

export const ConnectionRowItem = memo(
  function ConnectionRowItem({
    row,
    closed,
    onShowDetail,
    projectName,
    projectPolicy,
    projectInferred = false,
  }: Props) {
    const { t } = useTranslation()
    const onDelete = useLockFn(async () => closeConnection(row.id))
    const handleShowDetail = useCallback(
      () => onShowDetail(row.id),
      [onShowDetail, row.id],
    )
    const application = row.process || projectName || '未识别应用'
    const identifiedApplication = application !== '未识别应用'
    const title = identifiedApplication ? application : row.host
    const destination = identifiedApplication ? row.host : '等待应用识别'
    const route = row.chains || projectPolicy || ''
    const showTraffic = row.uploadSpeed >= 100 || row.downloadSpeed >= 100

    return (
      <div style={itemStyle}>
        <div style={contentStyle} onClick={handleShowDetail}>
          <div
            style={primaryStyle}
            title={row.processPath || projectName || row.host}
          >
            {title}
          </div>
          <div style={secondaryStyle}>
            <span
              style={{ ...secondaryItemStyle, maxWidth: '46%' }}
              title={destination}
            >
              {destination}
              {projectInferred && !row.process ? '（规则识别）' : ''}
            </span>
            {route && <span>·</span>}
            {route && (
              <span
                style={{ ...secondaryItemStyle, maxWidth: '34%' }}
                title={route}
              >
                {route}
              </span>
            )}
            <span>·</span>
            <span>
              <RelativeTime start={row.time} />
            </span>
          </div>
        </div>
        {showTraffic && (
          <div style={speedStyle}>
            <div>↓ {row.downloadSpeedText}</div>
            <div>↑ {row.uploadSpeedText}</div>
          </div>
        )}
        {!closed && (
          <IconButton
            size="small"
            color="inherit"
            onClick={onDelete}
            title={t('connections.components.actions.closeConnection')}
            aria-label={t('connections.components.actions.closeConnection')}
            sx={actionStyle}
          >
            <CloseRounded fontSize="small" />
          </IconButton>
        )}
      </div>
    )
  },
  (prev, next) =>
    prev.row === next.row &&
    prev.closed === next.closed &&
    prev.onShowDetail === next.onShowDetail &&
    prev.projectName === next.projectName &&
    prev.projectPolicy === next.projectPolicy &&
    prev.projectInferred === next.projectInferred,
)
