import { Tooltip, Typography, type TypographyProps } from '@mui/material'

export const softScrollAreaSx = {
  overscrollBehavior: 'contain',
  scrollbarWidth: 'thin',
  scrollbarColor: 'rgba(127, 127, 127, 0.36) transparent',
  '&::-webkit-scrollbar': {
    width: 7,
    height: 7,
  },
  '&::-webkit-scrollbar-track': {
    backgroundColor: 'transparent',
  },
  '&::-webkit-scrollbar-thumb': {
    backgroundColor: 'rgba(127, 127, 127, 0.34)',
    backgroundClip: 'padding-box',
    border: '2px solid transparent',
    borderRadius: 999,
  },
  '&::-webkit-scrollbar-thumb:hover': {
    backgroundColor: 'rgba(127, 127, 127, 0.54)',
  },
} as const

interface OverflowRevealProps {
  value: string
  variant?: TypographyProps['variant']
  color?: TypographyProps['color']
  fontWeight?: number | string
}

export const OverflowReveal = ({
  value,
  variant = 'body2',
  color,
  fontWeight,
}: OverflowRevealProps) => (
  <Tooltip title={value} placement="top-start" enterDelay={450} arrow>
    <Typography
      component="div"
      variant={variant}
      color={color}
      tabIndex={0}
      sx={{
        minWidth: 0,
        maxWidth: '100%',
        px: 0.5,
        py: 0.2,
        mx: -0.5,
        overflowX: 'auto',
        overflowY: 'hidden',
        whiteSpace: 'nowrap',
        fontWeight,
        cursor: 'text',
        borderRadius: 0.75,
        transition: 'background-color 120ms ease, box-shadow 120ms ease',
        ...softScrollAreaSx,
        '&:hover': {
          bgcolor: 'action.hover',
        },
        '&:focus-visible': {
          bgcolor: 'action.hover',
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: 1,
        },
      }}
    >
      {value}
    </Typography>
  </Tooltip>
)

export default OverflowReveal
