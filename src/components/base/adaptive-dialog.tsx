import {
  Dialog,
  useMediaQuery,
  useTheme,
  type DialogProps,
  type SxProps,
  type Theme,
} from '@mui/material'
import type { ReactNode } from 'react'

interface AdaptiveDialogProps
  extends Omit<
    DialogProps,
    'children' | 'fullScreen' | 'fullWidth' | 'maxWidth' | 'slotProps'
  > {
  children: ReactNode
  maxWidth?: DialogProps['maxWidth']
  fillDesktopHeight?: boolean
  paperSx?: SxProps<Theme>
}

export const AdaptiveDialog = ({
  children,
  maxWidth = 'md',
  fillDesktopHeight = false,
  paperSx,
  ...props
}: AdaptiveDialogProps) => {
  const theme = useTheme()
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'))
  const extraPaperSx = paperSx
    ? Array.isArray(paperSx)
      ? paperSx
      : [paperSx]
    : []

  return (
    <Dialog
      {...props}
      fullScreen={fullScreen}
      fullWidth
      maxWidth={maxWidth}
      scroll="paper"
      slotProps={{
        paper: {
          sx: [
            {
              m: { xs: 0, sm: 2 },
              width: { xs: '100%', sm: 'calc(100% - 32px)' },
              maxHeight: { xs: '100dvh', sm: 'calc(100dvh - 32px)' },
              height: fillDesktopHeight
                ? { xs: '100dvh', sm: 'min(860px, calc(100dvh - 32px))' }
                : { xs: '100dvh', sm: 'auto' },
              borderRadius: { xs: 0, sm: 3 },
              overflow: 'hidden',
            },
            ...extraPaperSx,
          ],
        },
      }}
    >
      {children}
    </Dialog>
  )
}

export default AdaptiveDialog
