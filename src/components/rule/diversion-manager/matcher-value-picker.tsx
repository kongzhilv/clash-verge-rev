import {
  CheckRounded,
  ChevronRightRounded,
  SearchRounded,
} from '@mui/icons-material'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  TextField,
  Typography,
} from '@mui/material'
import { useMemo, useState } from 'react'

import { useRulesData } from '@/providers/app-data-context'

import { matcherValueOptions } from './matcher-catalog'
import type { DiversionMatcher } from './model'

interface MatcherValuePickerProps {
  open: boolean
  matcher: DiversionMatcher
  onClose: () => void
  onSelect: (value: string) => void
}

export const MatcherValuePicker = ({
  open,
  matcher,
  onClose,
  onSelect,
}: MatcherValuePickerProps) => {
  const { ruleProviders } = useRulesData()
  const [search, setSearch] = useState('')

  const options = useMemo(
    () => matcherValueOptions(matcher.type, ruleProviders),
    [matcher.type, ruleProviders],
  )
  const filteredOptions = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return options
    return options.filter((option) =>
      `${option.label} ${option.value} ${option.description ?? ''}`
        .toLowerCase()
        .includes(keyword),
    )
  }, [options, search])

  const choose = (value: string) => {
    onSelect(value)
    setSearch('')
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>选择规则内容</DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <TextField
          fullWidth
          size="small"
          value={search}
          placeholder="搜索规则"
          onChange={(event) => setSearch(event.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRounded fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
          sx={{ p: 2, pb: 1 }}
        />

        {filteredOptions.length > 0 ? (
          <List disablePadding>
            {filteredOptions.map((option) => (
              <ListItemButton
                key={option.value}
                selected={matcher.value === option.value}
                onClick={() => choose(option.value)}
              >
                <ListItemText
                  primary={option.label}
                  secondary={
                    option.description
                      ? `${option.description} · ${option.value}`
                      : option.value
                  }
                />
                {matcher.value === option.value ? (
                  <CheckRounded color="primary" />
                ) : (
                  <ChevronRightRounded color="disabled" />
                )}
              </ListItemButton>
            ))}
          </List>
        ) : (
          <Typography sx={{ p: 2, color: 'text.secondary' }}>
            没有可选项，可以返回后手动输入。
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
      </DialogActions>
    </Dialog>
  )
}

export default MatcherValuePicker
