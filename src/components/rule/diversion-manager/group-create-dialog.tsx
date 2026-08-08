import {
  AddRounded,
  BlockRounded,
  ChevronRightRounded,
  ContentCopyRounded,
  LanguageRounded,
  LinkRounded,
  PublicRounded,
} from '@mui/icons-material'
import {
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
} from '@mui/material'
import type { ReactNode } from 'react'

import { AdaptiveDialog } from '@/components/base'

import { createMatcherForType } from './matcher-catalog'
import type { Action, DiversionGroup, DiversionMatcher } from './model'

interface GroupCreateDialogProps {
  open: boolean
  existingGroups: DiversionGroup[]
  onClose: () => void
  onCreate: (group: DiversionGroup) => void
}

interface GroupTemplate {
  id: string
  name: string
  description: string
  action: Action
  matchers: DiversionMatcher[]
  icon: ReactNode
}

const builtInMatcher = (value: string): DiversionMatcher => ({
  ...createMatcherForType('RULE-SET-BUILDIN'),
  value,
})

const TEMPLATES: GroupTemplate[] = [
  {
    id: 'cn-direct',
    name: '中国大陆直连',
    description: '中国大陆网站和 IP 直接连接。',
    action: 'direct',
    matchers: [builtInMatcher('geosite:cn'), builtInMatcher('geoip:cn')],
    icon: <LinkRounded />,
  },
  {
    id: 'non-cn-proxy',
    name: '境外网站代理',
    description: '常见境外网站跟随“当前选择”。',
    action: 'current',
    matchers: [builtInMatcher('geosite:geolocation-!cn')],
    icon: <PublicRounded />,
  },
  {
    id: 'ads-reject',
    name: '广告拦截',
    description: '拦截常见广告分类。',
    action: 'reject',
    matchers: [builtInMatcher('geosite:category-ads-all')],
    icon: <BlockRounded />,
  },
  {
    id: 'domain-custom',
    name: '自定义域名',
    description: '创建一个等待填写域名后缀的规则组。',
    action: 'current',
    matchers: [createMatcherForType('DOMAIN-SUFFIX')],
    icon: <LanguageRounded />,
  },
]

const uniqueName = (base: string, groups: DiversionGroup[]) => {
  const names = new Set(groups.map((group) => group.name.trim()))
  if (!names.has(base)) return base
  let index = 2
  while (names.has(`${base} ${index}`)) index += 1
  return `${base} ${index}`
}

const createGroup = (
  name: string,
  action: Action,
  matchers: DiversionMatcher[],
  groups: DiversionGroup[],
): DiversionGroup => ({
  id: crypto.randomUUID(),
  name: uniqueName(name, groups),
  enabled: true,
  logic: 'or',
  action,
  matchers: matchers.map((matcher) => ({
    ...matcher,
    id: crypto.randomUUID(),
  })),
})

export const GroupCreateDialog = ({
  open,
  existingGroups,
  onClose,
  onCreate,
}: GroupCreateDialogProps) => {
  const choose = (group: DiversionGroup) => {
    onCreate(group)
    onClose()
  }

  return (
    <AdaptiveDialog open={open} onClose={onClose} maxWidth="sm">
      <DialogTitle>添加自定义规则组</DialogTitle>
      <DialogContent
        dividers
        sx={{ p: 0, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
      >
        <List disablePadding>
          <ListSubheader>新建</ListSubheader>
          <ListItemButton
            onClick={() =>
              choose(
                createGroup(
                  `自定义分流组 ${existingGroups.length + 1}`,
                  'current',
                  [],
                  existingGroups,
                ),
              )
            }
            sx={{ alignItems: 'flex-start' }}
          >
            <ListItemIcon sx={{ mt: 0.25 }}>
              <AddRounded />
            </ListItemIcon>
            <ListItemText
              primary="空白规则组"
              secondary="先创建空白组，再选择要添加的匹配条件。"
              slotProps={{
                secondary: { sx: { overflowWrap: 'anywhere' } },
              }}
            />
            <ChevronRightRounded color="disabled" />
          </ListItemButton>

          <Divider />
          <ListSubheader>常用模板</ListSubheader>
          {TEMPLATES.map((template) => (
            <ListItemButton
              key={template.id}
              onClick={() =>
                choose(
                  createGroup(
                    template.name,
                    template.action,
                    template.matchers,
                    existingGroups,
                  ),
                )
              }
              sx={{ alignItems: 'flex-start' }}
            >
              <ListItemIcon sx={{ mt: 0.25 }}>{template.icon}</ListItemIcon>
              <ListItemText
                primary={template.name}
                secondary={template.description}
                slotProps={{
                  primary: { sx: { overflowWrap: 'anywhere' } },
                  secondary: { sx: { overflowWrap: 'anywhere' } },
                }}
              />
              <ChevronRightRounded color="disabled" />
            </ListItemButton>
          ))}

          {existingGroups.length > 0 && (
            <>
              <Divider />
              <ListSubheader>复制现有规则组</ListSubheader>
              {existingGroups.map((group) => (
                <ListItemButton
                  key={group.id}
                  onClick={() =>
                    choose({
                      ...group,
                      id: crypto.randomUUID(),
                      name: uniqueName(`${group.name} 副本`, existingGroups),
                      matchers: group.matchers.map((matcher) => ({
                        ...matcher,
                        id: crypto.randomUUID(),
                      })),
                    })
                  }
                  sx={{ alignItems: 'flex-start' }}
                >
                  <ListItemIcon sx={{ mt: 0.25 }}>
                    <ContentCopyRounded />
                  </ListItemIcon>
                  <ListItemText
                    primary={group.name || '未命名规则组'}
                    secondary={`${group.matchers.length} 个匹配条件`}
                    slotProps={{
                      primary: { sx: { overflowWrap: 'anywhere' } },
                    }}
                  />
                  <ChevronRightRounded color="disabled" />
                </ListItemButton>
              ))}
            </>
          )}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
      </DialogActions>
    </AdaptiveDialog>
  )
}

export default GroupCreateDialog
