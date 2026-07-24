import {
  ComputerRounded,
  HelpOutlineRounded,
  PowerSettingsNewRounded,
  SvgIconComponent,
  TroubleshootRounded,
} from '@mui/icons-material'
import {
  Box,
  CircularProgress,
  Fade,
  Paper,
  Stack,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { invoke } from '@tauri-apps/api/core'
import { ChangeEvent, FC, memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Switch } from '@/components/base'
import ProxyControlSwitches from '@/components/shared/proxy-control-switches'
import { useSystemProxyState } from '@/hooks/use-system-proxy-state'
import { useSystemState } from '@/hooks/use-system-state'
import { useVerge } from '@/hooks/use-verge'
import { showNotice } from '@/services/notice-service'

const LOCAL_STORAGE_TAB_KEY = 'clash-verge-proxy-active-tab'

interface TabButtonProps {
  isActive: boolean
  onClick: () => void
  icon: SvgIconComponent
  label: string
  hasIndicator?: boolean
}

const TabButton: FC<TabButtonProps> = memo(
  ({ isActive, onClick, icon: Icon, label, hasIndicator = false }) => (
    <Paper
      elevation={isActive ? 2 : 0}
      onClick={onClick}
      sx={{
        cursor: 'pointer',
        px: 2,
        py: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        bgcolor: isActive ? 'primary.main' : 'background.paper',
        color: isActive ? 'primary.contrastText' : 'text.primary',
        borderRadius: 1.5,
        flex: 1,
        maxWidth: 160,
        transition: 'all 0.2s ease-in-out',
        position: 'relative',
        '&:hover': {
          transform: 'translateY(-1px)',
          boxShadow: 1,
        },
        '&:after': isActive
          ? {
              content: '""',
              position: 'absolute',
              bottom: -9,
              left: '50%',
              width: 2,
              height: 9,
              bgcolor: 'primary.main',
              transform: 'translateX(-50%)',
            }
          : {},
      }}
    >
      <Icon fontSize="small" />
      <Typography variant="body2" sx={{ fontWeight: isActive ? 600 : 400 }}>
        {label}
      </Typography>
      {hasIndicator && (
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: isActive ? '#fff' : 'success.main',
            position: 'absolute',
            top: 8,
            right: 8,
          }}
        />
      )}
    </Paper>
  ),
)

interface TabDescriptionProps {
  description: string
  tooltipTitle: string
}

const TabDescription: FC<TabDescriptionProps> = memo(
  ({ description, tooltipTitle }) => (
    <Fade in={true} timeout={200}>
      <Typography
        variant="caption"
        component="div"
        sx={{
          width: '95%',
          textAlign: 'center',
          color: 'text.secondary',
          p: 0.8,
          borderRadius: 1,
          borderColor: 'primary.main',
          borderWidth: 1,
          borderStyle: 'solid',
          backgroundColor: 'background.paper',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0.5,
          wordBreak: 'break-word',
          hyphens: 'auto',
        }}
      >
        {description}
        <Tooltip title={tooltipTitle}>
          <HelpOutlineRounded
            sx={{ fontSize: 14, opacity: 0.7, flexShrink: 0 }}
          />
        </Tooltip>
      </Typography>
    </Fade>
  ),
)

export const ProxyTunCard: FC = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const [activeTab, setActiveTab] = useState<string>(
    () => localStorage.getItem(LOCAL_STORAGE_TAB_KEY) || 'system',
  )
  const [masterSwitchPending, setMasterSwitchPending] = useState(false)

  const { verge } = useVerge()
  const {
    runningMode,
    isCoreRunning,
    isTunModeAvailable,
    mutateSystemState,
    isLoading: systemStateLoading,
  } = useSystemState()
  const {
    configState: systemProxyConfigState,
    indicator: systemProxyIndicator,
    invalidateProxyState,
  } = useSystemProxyState()

  const { enable_tun_mode } = verge ?? {}
  const tunEnabled = Boolean(enable_tun_mode && isTunModeAvailable)
  const masterEnabled = !systemStateLoading && isCoreRunning

  const handleError = (err: unknown) => {
    showNotice.error(err)
  }

  const handleTabChange = (tab: string) => {
    setActiveTab(tab)
    localStorage.setItem(LOCAL_STORAGE_TAB_KEY, tab)
  }

  const handleMasterSwitch = async (
    _: ChangeEvent<HTMLInputElement>,
    value: boolean,
  ) => {
    if (masterSwitchPending || systemStateLoading) return

    setMasterSwitchPending(true)
    try {
      await invoke<void>(value ? 'start_proxy' : 'stop_proxy')
      await Promise.all([mutateSystemState(), invalidateProxyState()])
    } catch (error) {
      showNotice.error(error)
      await Promise.allSettled([
        mutateSystemState(),
        invalidateProxyState(),
      ])
    } finally {
      setMasterSwitchPending(false)
    }
  }

  const masterStatus = useMemo(() => {
    if (systemStateLoading) return '正在读取代理运行状态…'
    if (masterSwitchPending) return '正在切换代理运行状态…'
    if (!masterEnabled) return '已停止 · 系统代理、TUN 和规则设置保持不变'
    return runningMode === 'Service'
      ? '运行中 · 服务模式'
      : '运行中 · Sidecar 模式'
  }, [
    masterEnabled,
    masterSwitchPending,
    runningMode,
    systemStateLoading,
  ])

  const tabDescription = useMemo(() => {
    if (activeTab === 'system') {
      return {
        text: systemProxyConfigState
          ? t('home.components.proxyTun.status.systemProxyEnabled')
          : t('home.components.proxyTun.status.systemProxyDisabled'),
        tooltip: t('home.components.proxyTun.tooltips.systemProxy'),
      }
    }

    return {
      text: !isTunModeAvailable
        ? t('home.components.proxyTun.status.tunModeServiceRequired')
        : enable_tun_mode
          ? t('home.components.proxyTun.status.tunModeEnabled')
          : t('home.components.proxyTun.status.tunModeDisabled'),
      tooltip: t('home.components.proxyTun.tooltips.tunMode'),
    }
  }, [
    activeTab,
    systemProxyConfigState,
    enable_tun_mode,
    isTunModeAvailable,
    t,
  ])

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          mb: 1.5,
          p: 1.5,
          borderRadius: 2,
          border: '1px solid',
          borderColor: masterEnabled ? 'success.main' : 'divider',
          bgcolor: masterEnabled
            ? alpha(theme.palette.success.main, 0.08)
            : alpha(theme.palette.text.primary, 0.025),
          transition: 'background-color 0.2s, border-color 0.2s',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
          <Box
            sx={{
              width: 38,
              height: 38,
              display: 'grid',
              placeItems: 'center',
              borderRadius: '50%',
              color: masterEnabled ? 'success.main' : 'text.secondary',
              bgcolor: masterEnabled
                ? alpha(theme.palette.success.main, 0.12)
                : alpha(theme.palette.text.primary, 0.06),
            }}
          >
            {masterSwitchPending || systemStateLoading ? (
              <CircularProgress size={21} />
            ) : (
              <PowerSettingsNewRounded fontSize="small" />
            )}
          </Box>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              代理总开关
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {masterStatus}
            </Typography>
          </Box>
        </Box>

        <Switch
          edge="end"
          checked={masterEnabled}
          disabled={masterSwitchPending || systemStateLoading}
          onChange={handleMasterSwitch}
          inputProps={{ 'aria-label': '代理总开关' }}
        />
      </Box>

      <Stack
        direction="row"
        spacing={1}
        sx={{
          display: 'flex',
          justifyContent: 'center',
          position: 'relative',
          zIndex: 2,
        }}
      >
        <TabButton
          isActive={activeTab === 'system'}
          onClick={() => handleTabChange('system')}
          icon={ComputerRounded}
          label={t('settings.sections.system.toggles.systemProxy')}
          hasIndicator={systemProxyIndicator}
        />
        <TabButton
          isActive={activeTab === 'tun'}
          onClick={() => handleTabChange('tun')}
          icon={TroubleshootRounded}
          label={t('settings.sections.system.toggles.tunMode')}
          hasIndicator={tunEnabled}
        />
      </Stack>

      <Box
        sx={{
          width: '100%',
          my: 1,
          position: 'relative',
          display: 'flex',
          justifyContent: 'center',
          overflow: 'visible',
        }}
      >
        <TabDescription
          description={tabDescription.text}
          tooltipTitle={tabDescription.tooltip}
        />
      </Box>

      <Box
        sx={{
          mt: 0,
          p: 1,
          bgcolor: alpha(theme.palette.primary.main, 0.04),
          borderRadius: 2,
        }}
      >
        <ProxyControlSwitches
          onError={handleError}
          label={
            activeTab === 'system'
              ? t('settings.sections.system.toggles.systemProxy')
              : t('settings.sections.system.toggles.tunMode')
          }
          noRightPadding={true}
        />
      </Box>
    </Box>
  )
}
