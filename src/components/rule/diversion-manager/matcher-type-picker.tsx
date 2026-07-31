import {
  AppsRounded,
  ChevronRightRounded,
  DnsRounded,
  LanguageRounded,
  LanRounded,
  SearchRounded,
  SettingsEthernetRounded,
  TuneRounded,
} from '@mui/icons-material'
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Button,
  TextField,
} from '@mui/material'
import { useMemo, useState } from 'react'

import { MATCHER_TYPE_GROUPS } from './matcher-catalog'
import type { MatcherType } from './model'

interface MatcherTypePickerProps {
  open: boolean
  title?: string
  onClose: () => void
  onSelect: (type: MatcherType) => void
}

const typeIcon = (type: MatcherType) => {
  if (type === 'RULE-SET' || type === 'RULE-SET-BUILDIN') {
    return <DnsRounded />
  }
  if (
    type === 'DOMAIN' ||
    type === 'DOMAIN-SUFFIX' ||
    type === 'DOMAIN-KEYWORD' ||
    type === 'DOMAIN-REGEX' ||
    type === 'GEOSITE'
  ) {
    return <LanguageRounded />
  }
  if (type === 'PROCESS-NAME' || type === 'PROCESS-PATH') {
    return <AppsRounded />
  }
  if (type === 'IP-CIDR' || type === 'GEOIP') return <LanRounded />
  if (type === 'DST-PORT' || type === 'NETWORK') {
    return <SettingsEthernetRounded />
  }
  return <TuneRounded />
}

export const MatcherTypePicker = ({
  open,
  title = '选择匹配条件',
  onClose,
  onSelect,
}: MatcherTypePickerProps) => {
  const [search, setSearch] = useState('')

  const groups = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return MATCHER_TYPE_GROUPS
    return MATCHER_TYPE_GROUPS.map((group) => ({
      ...group,
      options: group.options.filter((option) =>
        `${option.label} ${option.description} ${option.type}`
          .toLowerCase()
          .includes(keyword),
      ),
    })).filter((group) => group.options.length > 0)
  }, [search])

  const choose = (type: MatcherType) => {
    onSelect(type)
    setSearch('')
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <TextField
          fullWidth
          size="small"
          value={search}
          placeholder="搜索域名、IP、进程、端口或 Rule Set"
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

        <List disablePadding>
          {groups.map((group) => (
            <li key={group.title}>
              <ul style={{ margin: 0, padding: 0 }}>
                <ListSubheader>{group.title}</ListSubheader>
                {group.options.map((option) => (
                  <ListItemButton
                    key={option.type}
                    onClick={() => choose(option.type)}
                  >
                    <ListItemIcon>{typeIcon(option.type)}</ListItemIcon>
                    <ListItemText
                      primary={option.label}
                      secondary={option.description}
                    />
                    <ChevronRightRounded color="disabled" />
                  </ListItemButton>
                ))}
              </ul>
            </li>
          ))}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
      </DialogActions>
    </Dialog>
  )
}

export default MatcherTypePicker
