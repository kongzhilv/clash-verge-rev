import { FilterAltRounded } from '@mui/icons-material'
import {
  Badge,
  Button,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  Menu,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import { useMemo, useState, type MouseEvent } from 'react'

export interface ConnectionFilters {
  application: string
  rule: string
  outbound: string
}

interface ConnectionFilterMenuProps {
  connections: IConnectionsItem[]
  value: ConnectionFilters
  onChange: (value: ConnectionFilters) => void
}

const processName = (connection: IConnectionsItem) => {
  const direct = String(connection.metadata.process ?? '').trim()
  if (direct) return direct
  const path = String(connection.metadata.processPath ?? '').trim()
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}

const actualOutbound = (connection: IConnectionsItem) =>
  connection.chains.at(-1)?.trim() ?? ''

const uniqueSorted = (values: string[]) =>
  [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, 'zh-CN'),
  )

export const ConnectionFilterMenu = ({
  connections,
  value,
  onChange,
}: ConnectionFilterMenuProps) => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const options = useMemo(
    () => ({
      applications: uniqueSorted(connections.map(processName)),
      rules: uniqueSorted(connections.map((item) => item.rule.trim())),
      outbounds: uniqueSorted(connections.map(actualOutbound)),
    }),
    [connections],
  )
  const activeCount = [value.application, value.rule, value.outbound].filter(
    Boolean,
  ).length

  const patch = (next: Partial<ConnectionFilters>) =>
    onChange({ ...value, ...next })

  const openMenu = (event: MouseEvent<HTMLElement>) =>
    setAnchor(event.currentTarget)

  return (
    <>
      <Tooltip title="按应用、规则或出口筛选">
        <IconButton size="small" onClick={openMenu} aria-label="连接筛选">
          <Badge badgeContent={activeCount} color="primary">
            <FilterAltRounded fontSize="small" />
          </Badge>
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        slotProps={{ paper: { sx: { width: 320, maxWidth: 'calc(100vw - 24px)' } } }}
      >
        <Stack spacing={1.25} sx={{ px: 1.5, py: 1 }}>
          <Typography variant="subtitle2">连接筛选</Typography>
          <FormControl size="small" fullWidth>
            <InputLabel>应用</InputLabel>
            <Select
              label="应用"
              value={value.application}
              onChange={(event) => patch({ application: event.target.value })}
            >
              <MenuItem value="">全部应用</MenuItem>
              {options.applications.map((item) => (
                <MenuItem key={item} value={item}>
                  {item}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>命中规则</InputLabel>
            <Select
              label="命中规则"
              value={value.rule}
              onChange={(event) => patch({ rule: event.target.value })}
            >
              <MenuItem value="">全部规则</MenuItem>
              {options.rules.map((item) => (
                <MenuItem key={item} value={item}>
                  {item}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>实际出口</InputLabel>
            <Select
              label="实际出口"
              value={value.outbound}
              onChange={(event) => patch({ outbound: event.target.value })}
            >
              <MenuItem value="">全部出口</MenuItem>
              {options.outbounds.map((item) => (
                <MenuItem key={item} value={item}>
                  {item}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>
        <Divider />
        <Stack direction="row" sx={{ px: 1.5, py: 0.75, justifyContent: 'flex-end' }}>
          <Button
            size="small"
            disabled={activeCount === 0}
            onClick={() =>
              onChange({ application: '', rule: '', outbound: '' })
            }
          >
            清除筛选
          </Button>
        </Stack>
      </Menu>
    </>
  )
}

export default ConnectionFilterMenu
