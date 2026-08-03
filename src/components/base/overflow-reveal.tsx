import { Box, Tooltip, Typography, type TypographyProps } from '@mui/material'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type WheelEvent,
} from 'react'

import { softScrollAreaSx } from './scroll-area'

interface OverflowRevealProps {
  value: string
  variant?: TypographyProps['variant']
  color?: TypographyProps['color']
  fontWeight?: number | string
}

interface ScrollState {
  overflowing: boolean
  atStart: boolean
  atEnd: boolean
}

const INITIAL_SCROLL_STATE: ScrollState = {
  overflowing: false,
  atStart: true,
  atEnd: true,
}

export const OverflowReveal = ({
  value,
  variant = 'body2',
  color,
  fontWeight,
}: OverflowRevealProps) => {
  const contentRef = useRef<HTMLDivElement>(null)
  const [scrollState, setScrollState] = useState(INITIAL_SCROLL_STATE)

  const measure = useCallback(() => {
    const node = contentRef.current
    if (!node) return

    const maxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth)
    const nextState: ScrollState = {
      overflowing: maxScrollLeft > 2,
      atStart: node.scrollLeft <= 2,
      atEnd: node.scrollLeft >= maxScrollLeft - 2,
    }
    setScrollState((previous) =>
      previous.overflowing === nextState.overflowing &&
      previous.atStart === nextState.atStart &&
      previous.atEnd === nextState.atEnd
        ? previous
        : nextState,
    )
  }, [])

  useEffect(() => {
    const node = contentRef.current
    if (!node) return

    const frame = window.requestAnimationFrame(measure)
    if (typeof ResizeObserver === 'undefined') {
      return () => window.cancelAnimationFrame(frame)
    }

    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [measure, value])

  const scrollBy = (distance: number) => {
    contentRef.current?.scrollBy({ left: distance, behavior: 'smooth' })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const node = contentRef.current
    if (!node || !scrollState.overflowing) return

    const step = Math.max(64, node.clientWidth * 0.55)
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      scrollBy(-step)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      scrollBy(step)
    } else if (event.key === 'Home') {
      event.preventDefault()
      node.scrollTo({ left: 0, behavior: 'smooth' })
    } else if (event.key === 'End') {
      event.preventDefault()
      node.scrollTo({ left: node.scrollWidth, behavior: 'smooth' })
    }
  }

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!scrollState.overflowing || !event.shiftKey) return
    event.preventDefault()
    scrollBy(event.deltaY || event.deltaX)
  }

  return (
    <Box sx={{ position: 'relative', minWidth: 0, maxWidth: '100%' }}>
      <Tooltip
        title={scrollState.overflowing ? value : ''}
        placement="top-start"
        enterDelay={450}
        arrow
      >
        <Typography
          ref={contentRef}
          component="div"
          variant={variant}
          color={color}
          tabIndex={scrollState.overflowing ? 0 : -1}
          aria-label={value}
          onScroll={measure}
          onKeyDown={handleKeyDown}
          onWheel={handleWheel}
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
            cursor: scrollState.overflowing ? 'ew-resize' : 'text',
            borderRadius: 0.75,
            transition: 'background-color 120ms ease, box-shadow 120ms ease',
            ...softScrollAreaSx,
            '&:hover': {
              bgcolor: scrollState.overflowing ? 'action.hover' : undefined,
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

      {scrollState.overflowing && !scrollState.atStart && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: '0 auto 7px 0',
            width: 16,
            pointerEvents: 'none',
            background: (theme) =>
              `linear-gradient(90deg, ${theme.palette.action.hover}, transparent)`,
          }}
        />
      )}
      {scrollState.overflowing && !scrollState.atEnd && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: '0 0 7px auto',
            width: 18,
            pointerEvents: 'none',
            background: (theme) =>
              `linear-gradient(270deg, ${theme.palette.action.hover}, transparent)`,
          }}
        />
      )}
    </Box>
  )
}

export default OverflowReveal
