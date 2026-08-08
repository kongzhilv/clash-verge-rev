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
