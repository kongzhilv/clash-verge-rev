import { memo, useCallback } from 'react'

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
  padding: '8px 12px',
  borderBottom: '1px solid var(--divider-color)',
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

export const ConnectionRowItem = memo(
  function ConnectionRowItem({
    row,
    closed,
    onShowDetail,
    projectName,
    projectPolicy,
    projectInferred = false,
  }: Props) {
    const handleShowDetail = useCallback(
      () => onShowDetail(row.id),
      [onShowDetail, row.id],
    )
    const application = row.process || projectName || '未识别应用'
    const identifiedApplication = application !== '未识别应用'
    const title = identifiedApplication ? application : row.host
    const destination = identifiedApplication ? row.host : '等待应用识别'
    const route = row.chains || projectPolicy || '出口未知'
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
            <span>·</span>
            <span
              style={{ ...secondaryItemStyle, maxWidth: '34%' }}
              title={route}
            >
              {route}
            </span>
            <span>·</span>
            <span>{closed ? '已结束' : <RelativeTime start={row.time} />}</span>
          </div>
        </div>
        {showTraffic && (
          <div style={speedStyle}>
            <div>↓ {row.downloadSpeedText}</div>
            <div>↑ {row.uploadSpeedText}</div>
          </div>
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
