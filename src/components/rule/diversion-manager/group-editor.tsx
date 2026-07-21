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
  const updateMatcher = (
    matcherIndex: number,
    patch: Partial<DiversionMatcher>,
  ) => {
    onChange({
      matchers: group.matchers.map((matcher, currentIndex) =>
        currentIndex === matcherIndex ? { ...matcher, ...patch } : matcher,
      ),
    })
  }

  const deleteMatcher = (matcherIndex: number) => {
    onChange({
      matchers: group.matchers.filter(
        (_, currentIndex) => currentIndex !== matcherIndex,
      ),
    })
  }

  return (
    <Accordion defaultExpanded={index === 0}>
      <AccordionSummary expandIcon={<ExpandMoreRounded />}>
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{ width: '100%', pr: 1 }}
        >
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
      </AccordionSummary>

      <AccordionDetails>
        <Stack spacing={1.5}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField
              fullWidth
              size="small"
              label="分流组名称"
              value={group.name}
              onChange={(event) => onChange({ name: event.target.value })}
            />

            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel>条件逻辑</InputLabel>
              <Select
                label="条件逻辑"
                value={group.logic}
                onChange={(event) =>
                  onChange({ logic: event.target.value as 'or' | 'and' })
                }
              >
                <MenuItem value="or">OR（满足一项）</MenuItem>
                <MenuItem value="and">AND（满足全部）</MenuItem>
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel>匹配动作</InputLabel>
              <Select
                label="匹配动作"
                value={group.action}
                onChange={(event) =>
                  onChange({ action: event.target.value as Action })
                }
              >
                {ACTIONS.map(([action, label]) => (
                  <MenuItem key={action} value={action}>
                    {label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          {group.action === 'policy' && (
            <TextField
              size="small"
              label="指定策略组或节点名称"
              value={group.policy ?? ''}
              onChange={(event) => onChange({ policy: event.target.value })}
            />
          )}

          <Divider />

          <Stack spacing={1}>
            {group.matchers.map((matcher, matcherIndex) => (
              <MatcherEditor
                key={`${matcher.type}-${matcherIndex}`}
                matcher={matcher}
                onChange={(patch) => updateMatcher(matcherIndex, patch)}
                onDelete={() => deleteMatcher(matcherIndex)}
              />
            ))}
          </Stack>

          <Button
            variant="text"
            startIcon={<AddRounded />}
            onClick={() =>
              onChange({ matchers: [...group.matchers, makeMatcher()] })
            }
          >
            添加匹配项
          </Button>

          <Divider />

          <Stack
            direction="row"
            justifyContent="space-between"
            alignItems="center"
          >
            <Stack direction="row">
              <IconButton
                disabled={index === 0}
                onClick={() => onMove(-1)}
                aria-label="上移分流组"
              >
                <ArrowUpwardRounded />
              </IconButton>
              <IconButton
                disabled={index === total - 1}
                onClick={() => onMove(1)}
                aria-label="下移分流组"
              >
                <ArrowDownwardRounded />
              </IconButton>
            </Stack>

            <Button
              color="error"
              startIcon={<DeleteOutlineRounded />}
              onClick={onDelete}
            >
              删除分流组
            </Button>
          </Stack>
        </Stack>
      </AccordionDetails>
    </Accordion>
  )
}

export default GroupEditor
