import { Box } from '@mui/material'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'

import {
  BaseEmpty,
  BasePage,
  BaseSearchBox,
  VirtualList,
  type VirtualListHandle,
} from '@/components/base'
import { ScrollTopButton } from '@/components/layout/scroll-top-button'
import DiversionDetector from '@/components/rule/diversion-detector'
import DiversionManager from '@/components/rule/diversion-manager/index'
import { ProviderButton } from '@/components/rule/provider-button'
import RuleItem from '@/components/rule/rule-item'
import RoutingRelationsPanel from '@/components/routing/routing-relations-panel'
import { useVisibility } from '@/hooks/use-visibility'
import { useAppRefreshers, useRulesData } from '@/providers/app-data-context'

const RulesPage = () => {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const focusProjectId = searchParams.get('project')
  const manageProjects = searchParams.get('manage') === 'projects'
  const { rules = [] } = useRulesData()
  const { refreshRules, refreshRuleProviders } = useAppRefreshers()
  const [match, setMatch] = useState(() => (_: string) => true)
  const virtuosoRef = useRef<VirtualListHandle>(null)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const pageVisible = useVisibility()

  useEffect(() => {
    refreshRules()
    refreshRuleProviders()

    if (pageVisible) {
      refreshRules()
      refreshRuleProviders()
    }
  }, [refreshRules, refreshRuleProviders, pageVisible])

  const filteredRules = useMemo(() => {
    const rulesWithLineNo = rules.map((item, index) => ({
      ...item,
      lineNo: index + 1,
    }))

    return rulesWithLineNo.filter((item) => match(item.payload ?? ''))
  }, [rules, match])

  const handleScroll = useCallback((event: Event) => {
    setShowScrollTop((event.target as HTMLElement).scrollTop > 100)
  }, [])

  const scrollToTop = () => {
    virtuosoRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <BasePage
      full
      title={t('rules.page.title')}
      contentStyle={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      header={
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            flexWrap: 'wrap',
          }}
        >
          <DiversionManager
            initialOpen={manageProjects || Boolean(focusProjectId)}
            focusProjectId={focusProjectId}
          />
          <DiversionDetector />
          <ProviderButton />
        </Box>
      }
    >
      <Box sx={{ mx: '10px', pt: 1 }}>
        <RoutingRelationsPanel />
      </Box>

      <Box
        sx={{
          pt: 1,
          mb: 0.5,
          mx: '10px',
          height: '36px',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <BaseSearchBox onSearch={(nextMatch) => setMatch(() => nextMatch)} />
      </Box>

      {filteredRules.length > 0 ? (
        <>
          <VirtualList
            ref={virtuosoRef}
            count={filteredRules.length}
            estimateSize={40}
            renderItem={(index) => <RuleItem value={filteredRules[index]} />}
            style={{ flex: 1 }}
            onScroll={handleScroll}
          />
          <ScrollTopButton onClick={scrollToTop} show={showScrollTop} />
        </>
      ) : (
        <BaseEmpty />
      )}
    </BasePage>
  )
}

export default RulesPage
