import {
  AddRounded,
  ArrowDownwardRounded,
  ArrowUpwardRounded,
  DeleteOutlineRounded,
  ExpandMoreRounded,
} from '@mui/icons-material'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Button,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'

import MatcherEditor from './matcher-editor'
import {
  ACTIONS,
  makeMatcher,
  type Action,
  type DiversionGroup,
  type DiversionMatcher,
} from './model'

interface GroupEditorProps {
  group: DiversionGroup
  index: number
  total: number
  onChange: (patch: Partial<DiversionGroup>) => void
  onMove: (direction: -1 | 1) => void
  onDelete: () => void
}

export const GroupEditor = ({
  group,
  index,
  total,
  onChange,
  onMove,
  onDelete,
}: GroupEditorProps) => {
  const updateMatcher = (matcherIndex: number, patch: Partial<DiversionMatcher>) => {
    onChange({
      matchers: group.matchers.map((matcher, currentIndex) =>
        currentIndex === matcherIndex ? { ...matcher, ...patch } : matcher,
      ),
    })
  }

  const deleteMatcher = (matcherIndex: number) => {
    onChange({
      matchers: group.matchers.filter((_, currentIndex) => currentIndex !== matcherIndex),
    })
  }

  return (
    <Accordion defaultExpanded={index === 0}>
      <AccordionSummary expandIcon={<ExpandMoreRounded />}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ width: '100%', pr: 1 }}>
          <Switch
            size="small"
            checked={group.enabled}
            onClick={(event) => event.stopPropagation()}
            onChange={(_, checked) => onChange({ enabled: checked })}
          />
          <Typography sx={{ flex: 1, fontWeight: 600 }}>
            {group.name || '未命名分流组'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {group.logic.toUpperCase()} · {group.matchers.length} 项
          </Typography>
        </Stack>
      </Accordion