import { DeleteOutlineRounded } from '@mui/icons-material'
import {
  Alert,
  Box,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
} from '@mui/material'

import {
  MATCHER_TYPES,
  type DiversionMatcher,
  type MatcherType,
} from './model'

interface MatcherEditorProps {
  matcher: DiversionMatcher
  onChange: (patch: Partial<DiversionMatcher>) => void
  onDelete: () => void
}

const valueField = (type: MatcherType) => {
  if (type === 'RULE-SET') {
    return {
      label: '规则集名称/已有 provider 名称',
      placeholder: '例如 openai-rules',
      helperText: '填写已有 rule-provider 名称；也可以在下方提供远程 URL 自动创建 provider。',
    }
  }
  if (type === 'RULE-SET-BUILDIN') {
    return {
      label: '内置规则集',
      placeholder