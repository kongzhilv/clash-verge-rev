import {
  AddRounded,
  ArrowDownwardRounded,
  ArrowUpwardRounded,
  ChevronRightRounded,
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
import { useState } from 'react'

import ActionPicker, { actionLabel } from './action-picker'
import { createMatcherForType } from './matcher-catalog'
import MatcherEditor from './matcher-editor'
import MatcherTypePicker from './matcher-type-picker'
import type {
  DiversionGroup,
  DiversionMatcher,
  MatcherType,
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
  const [actionPickerOpen, setActionPickerOpen] = useState(false)
  const [matcherPickerOpen, setMatcherPickerOpen] = useState(false)

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

  const addMatcher = (type: MatcherType) => {
    onChange({
      matchers: [...group.matchers, createMatcherForType(type)],
    })
  }

  return (
    <Accordion defaultExpanded={index === 0}>
      <AccordionSummary expandIcon={<ExpandMoreRounded />}>
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: 'center',
            width: '100%',
            pr: 1,
          }}
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
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {actionLabel(group.action, group.policy)} · {group.matchers.length} 项
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

            <FormControl size="small" sx={{ minWidth: 170 }}>
              <InputLabel>条件逻辑</InputLabel>
              <Select
                label="条件逻辑"
                value={group.logic}
                onChange={(event) =>
                  onChange({ logic: event.target.value as 'or' | 'and' })
                }
              >
                <MenuItem value="or">满足任意条件</MenuItem>
                <MenuItem value="and">同时满足全部条件</MenuItem>
              </Select>
            </FormControl>

            <Button
              variant="outlined"
              endIcon={<ChevronRightRounded />}
              onClick={() => setActionPickerOpen(true)}
              sx={{ minWidth: 210, justifyContent: 'space-between' }}
            >
              {actionLabel(group.action, group.policy)}
            </Button>
          </Stack>

          <ActionPicker
            open={actionPickerOpen}
            title={`${group.name || '未命名分流组'}的处理方式`}
            action={group.action}
            policy={group.policy}
            allowDrop
            onClose={() => setActionPickerOpen(false)}
            onSelect={(action, policy) =>
              onChange({
                enabled: action !== 'none',
                action,
                policy: action === 'policy' ? policy : undefined,
              })
            }
          />

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
            {group.matchers.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                还没有匹配条件。点击下面的按钮选择要添加的规则类型。
              </Typography>
            ) : (
              group.matchers.map((matcher, matcherIndex) => (
                <MatcherEditor
                  key={matcher.id}
                  matcher={matcher}
                  onChange={(patch) => updateMatcher(matcherIndex, patch)}
                  onDelete={() => deleteMatcher(matcherIndex)}
                />
              ))
            )}
          </Stack>

          <Button
            variant="text"
            startIcon={<AddRounded />}
            onClick={() => setMatcherPickerOpen(true)}
          >
            添加匹配条件
          </Button>

          <MatcherTypePicker
            open={matcherPickerOpen}
            onClose={() => setMatcherPickerOpen(false)}
            onSelect={addMatcher}
          />

          <Divider />

          <Stack
            direction="row"
            sx={{
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
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
