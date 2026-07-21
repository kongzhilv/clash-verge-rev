import { AddRounded, CloseRounded, SaveRounded, TuneRounded } from '@mui/icons-material'
import {
  AppBar,
  Box,
  Button,
  Dialog,
  IconButton,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material'
import { useCallback, useMemo, useState } from 'react'

import { readProfileFile, saveProfileFile } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

import GroupEditor from './group-editor'
import { default