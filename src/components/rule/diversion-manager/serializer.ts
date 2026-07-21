import { dump, load } from 'js-yaml'

import {
  CONFIG_KEY,
  cleanConfig,
  defaultConfig,
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

export const parseDiversionProfile = (content: string): ParsedDiversionProfile => {
  const parsed = content.trim() ? load(content) : {}
  const mergeConfig = isRecord(parsed) ? parsed : {}

  return {
    mergeConfig,
    config: isRecord(mergeConfig[CONFIG_KEY])
      ? normalize