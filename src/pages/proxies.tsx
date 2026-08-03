import { LanOutlined, LanRounded, WarningRounded } from '@mui/icons-material'
import {
  Box,
  Button,
  ButtonGroup,
  IconButton,
  Stack,
  Tooltip,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useCallback, useEffect, useReducer, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { closeAllConnections } from 'tauri-plugin-mihomo-api'

import { BasePage, TooltipIcon } from '@/components/base'
import { ProviderButton } from '@/components/proxy/provider-button'
import { ProxyGroups } from '@/components/proxy/proxy-groups'
import FocusedPolicyPanel from '@/components/routing/focused-policy-panel'
import RoutingRelationsPanel from '@/components/routing/routing-relations-panel'
import { useVerge } from '@/hooks/use-verge'
import {
  useAppRefreshers,
  useClashConfigData,
} from '@/providers/app-data-context'
import {
  getRuntimeProxyChainConfig,
  patchClashMode,
  updateProxyChainConfigInRuntime,
} from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { debugLog } from '@/utils/debug'

const MODES = ['rule', 'global', 'direct'] as const
type Mode = (typeof MODES)[number]
const MODE_SET = new Set<string>(MODES)
const isMode = (value: unknown): value is Mode =>
  typeof value === 'string' && MODE_SET.has(value)

const ProxyPage = () => {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const policyFilter = searchParams.get('policy')

  const [isChainMode, setIsChainMode] = useState(() => {
    try {
      const saved = localStorage.getItem('proxy-chain-mode-enabled')
      return saved === 'true'
    } catch {
      return false
    }
  })

  const [chainConfigData, dispatchChainConfigData] = useReducer(
    (_: string | null, action: string | null) => action,
    null as string | null,
  )

  const { clashConfig } = useClashConfigData()
  const { refreshClashConfig } = useAppRefreshers()

  const updateChainConfigData = useCallback((value: string | null) => {
    dispatchChainConfigData(value)
  }, [])
  const { verge } = useVerge()

  const normalizedMode = clashConfig?.mode?.toLowerCase()
  const curMode = isMode(normalizedMode) ? normalizedMode : undefined
  const chainWarning = t('proxies.page.chain.warning')

  const onChangeMode = useLockFn(async (mode: Mode) => {
    if (mode !== curMode && verge?.auto_close_connection) {
      closeAllConnections()
    }
    try {
      await patchClashMode(mode)
      refreshClashConfig()
    } catch (error) {
      showNotice.error(error)
    }
  })

  const onToggleChainMode = useLockFn(async () => {
    const newChainMode = !isChainMode

    setIsChainMode(newChainMode)
    localStorage.setItem('proxy-chain-mode-enabled', newChainMode.toString())

    if (!newChainMode) {
      try {
        debugLog('Exiting chain mode, clearing chain configuration')
        await updateProxyChainConfigInRuntime(null)
        debugLog('Chain configuration cleared successfully')
      } catch (error) {
        console.error('Failed to clear chain configuration:', error)
      }
    }
  })

  useEffect(() => {
    if (!isChainMode) {
      updateChainConfigData(null)
      return
    }

    let cancelled = false

    const fetchChainConfig = async () => {
      try {
        const exitNode = localStorage.getItem('proxy-chain-exit-node')

        if (!exitNode) {
          console.error('No proxy chain exit node found in localStorage')
          if (!cancelled) updateChainConfigData('')
          return
        }

        const configData = await getRuntimeProxyChainConfig(exitNode)
        if (!cancelled) updateChainConfigData(configData || '')
      } catch (error) {
        console.error('Failed to get runtime proxy chain config:', error)
        if (!cancelled) updateChainConfigData('')
      }
    }

    void fetchChainConfig()

    return () => {
      cancelled = true
    }
  }, [isChainMode, updateChainConfigData])

  useEffect(() => {
    if (normalizedMode && !isMode(normalizedMode)) {
      void onChangeMode('rule')
    }
  }, [normalizedMode, onChangeMode])

  return (
    <BasePage
      full
      contentStyle={{ height: '100%', overflow: 'hidden' }}
      title={
        isChainMode ? (
          <Box
            component="span"
            data-tauri-drag-region="true"
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
          >
            {t('proxies.page.title.chainMode')}
            <TooltipIcon
              title={chainWarning}
              icon={WarningRounded}
              color="warning"
              sx={{ p: 0.25 }}
            />
          </Box>
        ) : (
          t('proxies.page.title.default')
        )
      }
      header={
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <ProviderButton />

          <ButtonGroup size="small">
            {MODES.map((mode) => (
              <Button
                key={mode}
                variant={mode === curMode ? 'contained' : 'outlined'}
                onClick={() => void onChangeMode(mode)}
                sx={{ minWidth: 58, textTransform: 'none' }}
              >
                {t(`proxies.page.modes.${mode}`)}
              </Button>
            ))}
          </ButtonGroup>

          <Tooltip title={t('proxies.page.actions.toggleChain')}>
            <IconButton
              size="small"
              color={isChainMode ? 'primary' : 'default'}
              onClick={() => void onToggleChainMode()}
            >
              {isChainMode ? (
                <LanRounded fontSize="small" />
              ) : (
                <LanOutlined fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        </Stack>
      }
    >
      <Stack sx={{ height: '100%', minHeight: 0 }} spacing={1}>
        {policyFilter && (
          <Box sx={{ px: 1.25, pt: 1.25 }}>
            <Stack spacing={1}>
              <FocusedPolicyPanel policy={policyFilter} />
              <RoutingRelationsPanel policyFilter={policyFilter} compact />
            </Stack>
          </Box>
        )}
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <ProxyGroups
            mode={curMode ?? 'rule'}
            isChainMode={isChainMode}
            chainConfigData={chainConfigData}
          />
        </Box>
      </Stack>
    </BasePage>
  )
}

export default ProxyPage
