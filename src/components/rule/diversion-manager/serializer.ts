import { dump, load } from 'js-yaml'

import {
  CONFIG_KEY,
  cleanConfig,
  isRecord,
  normalizeConfig,
  validateConfig,
  type DiversionConfig,
  type UnknownRecord,
} from './model'

export interface ParsedDiversionProfile {
  mergeConfig: UnknownRecord
  config: DiversionConfig
}

export interface SerializedDiversionProfile {
  mergeConfig: UnknownRecord
  content: string
}

export const parseDiversionProfile = (
  content: string,
): ParsedDiversionProfile => {
  const parsed = content.trim() ? load(content) : {}
  const mergeConfig = isRecord(parsed) ? parsed : {}

  return {
    mergeConfig,
    config: normalizeConfig(mergeConfig[CONFIG_KEY]),
  }
}

export const serializeDiversionProfile = (
  mergeConfig: UnknownRecord,
  config: DiversionConfig,
): SerializedDiversionProfile => {
  const error = validateConfig(config)
  if (error) throw new Error(error)

  const nextMerge: UnknownRecord = {
    ...mergeConfig,
    [CONFIG_KEY]: cleanConfig(config),
  }

  return {
    mergeConfig: nextMerge,
    content: dump(nextMerge, {
      noRefs: true,
      lineWidth: 120,
      noCompatMode: true,
    }),
  }
}
