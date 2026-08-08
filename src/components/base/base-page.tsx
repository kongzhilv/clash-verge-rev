import { Box, Typography } from '@mui/material'
import React, { ReactNode } from 'react'

import { BaseErrorBoundary } from './base-error-boundary'

interface Props {
  title?: React.ReactNode
  header?: React.ReactNode
  contentStyle?: React.CSSProperties
  children?: ReactNode
  full?: boolean
}

export const BasePage: React.FC<Props> = ({
  title,
  header,
  contentStyle,
  full,
  children,
}) => (
  <BaseErrorBoundary>
    <Box className="base-page" sx={{ bgcolor: 'background.default' }}>
      <Box
        component="header"
        data-tauri-drag-region="true"
        sx={{
          minHeight: 58,
          px: 2,
          gap: 1.5,
          display: 'flex',
          alignItems: 'center',
          userSelect: 'none',
          bgcolor: 'background.paper',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Typography
          variant="h6"
          data-tauri-drag-region="true"
          sx={{
            minWidth: 0,
            fontSize: 19,
            fontWeight: 700,
            letterSpacing: '-0.015em',
          }}
        >
          {title}
        </Typography>

        {header && (
          <Box
            sx={{
              ml: 'auto',
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 1,
            }}
          >
            {header}
          </Box>
        )}
      </Box>

      <Box
        className={full ? 'base-container no-padding' : 'base-container'}
        sx={{ bgcolor: 'background.default' }}
      >
        <Box component="section" sx={{ bgcolor: 'background.default' }}>
          <div className="base-content" style={contentStyle}>
            {children}
          </div>
        </Box>
      </Box>
    </Box>
  </BaseErrorBoundary>
)
