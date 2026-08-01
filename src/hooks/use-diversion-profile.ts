import { useCallback, useEffect, useState } from 'react'

import type { DiversionConfig } from '@/components/rule/diversion-manager/model'
import {
  parseDiversionProfile,
  type ParsedDiversionProfile,
} from '@/components/rule/diversion-manager/serializer'
import { readProfileFile } from '@/services/cmds'

const EVENT_NAME = 'karing-diversion-updated'

interface DiversionUpdatedDetail {
  config?: DiversionConfig
}

export const notifyDiversionUpdated = (config?: DiversionConfig) => {
  window.dispatchEvent(
    new CustomEvent<DiversionUpdatedDetail>(EVENT_NAME, {
      detail: { config },
    }),
  )
}

export const useDiversionProfile = () => {
  const [profile, setProfile] = useState<ParsedDiversionProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const content = await readProfileFile('Merge')
      setProfile(parseDiversionProfile(content))
    } catch (error) {
      console.error('[Karing] failed to load diversion profile', error)
      setProfile(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()

    const handleUpdate = (event: Event) => {
      const custom = event as CustomEvent<DiversionUpdatedDetail>
      if (custom.detail?.config) {
        setProfile((previous) =>
          previous
            ? { ...previous, config: custom.detail.config as DiversionConfig }
            : previous,
        )
        return
      }
      void reload()
    }
    const handleFocus = () => void reload()

    window.addEventListener(EVENT_NAME, handleUpdate)
    window.addEventListener('focus', handleFocus)
    return () => {
      window.removeEventListener(EVENT_NAME, handleUpdate)
      window.removeEventListener('focus', handleFocus)
    }
  }, [reload])

  return { profile, loading, reload }
}
