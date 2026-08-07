import { RefreshRounded, StorageOutlined } from '@mui/icons-material'
import {
  Box,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
  alpha,
  styled,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import dayjs from 'dayjs'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { updateRuleProvider } from 'tauri-plugin-mihomo-api'

import { AdaptiveDialog } from '@/components/base'
import { useAppRefreshers, useRulesData } from '@/providers/app-data-context'
import { showNotice } from '@/services/notice-service'

const TypeBox = styled(Box)<{ component?: React.ElementType }>(({ theme }) => ({
  display: 'inline-block',
  border: '1px solid #ccc',
  borderColor: alpha(theme.palette.secondary.main, 0.5),
  color: alpha(theme.palette.secondary.main, 0.8),
  borderRadius: 4,
  fontSize: 10,
  marginRight: '4px',
  padding: '0 2px',
  lineHeight: 1.25,
}))

export const ProviderButton = () => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { ruleProviders } = useRulesData()
  const { refreshRules, refreshRuleProviders } = useAppRefreshers()
  const [updating, setUpdating] = useState<Record<string, boolean>>({})

  const hasProviders = Object.keys(ruleProviders || {}).length > 0

  const updateProvider = useLockFn(async (name: string) => {
    try {
      setUpdating((prev) => ({ ...prev, [name]: true }))
      await updateRuleProvider(name)
      await refreshRules()
      await refreshRuleProviders()
      showNotice.success(
        'rules.feedback.notifications.provider.updateSuccess',
        {
          name,
        },
      )
    } catch (err) {
      showNotice.error('rules.feedback.notifications.provider.updateFailed', {
        name,
        message: String(err),
      })
    } finally {
      setUpdating((prev) => ({ ...prev, [name]: false }))
    }
  })

  const updateAllProviders = useLockFn(async () => {
    try {
      const allProviders = Object.keys(ruleProviders || {})
      if (allProviders.length === 0) {
        showNotice.info('rules.feedback.notifications.provider.none')
        return
      }

      const newUpdating = allProviders.reduce(
        (acc, key) => {
          acc[key] = true
          return acc
        },
        {} as Record<string, boolean>,
      )
      setUpdating(newUpdating)

      for (const name of allProviders) {
        try {
          await updateRuleProvider(name)
          setUpdating((prev) => ({ ...prev, [name]: false }))
        } catch (err) {
          console.error(`更新 ${name} 失败`, err)
        }
      }

      await refreshRules()
      await refreshRuleProviders()
      showNotice.success('rules.feedback.notifications.provider.allUpdated')
    } catch (err) {
      showNotice.error('rules.feedback.notifications.provider.genericError', {
        message: String(err),
      })
    } finally {
      setUpdating({})
    }
  })

  const handleClose = () => {
    setOpen(false)
  }

  if (!hasProviders) return null

  return (
    <>
      <Button
        variant="outlined"
        size="small"
        startIcon={<StorageOutlined />}
        onClick={() => setOpen(true)}
      >
        {t('rules.page.provider.trigger')}
      </Button>
      <AdaptiveDialog
        open={open}
        onClose={handleClose}
        maxWidth="sm"
        aria-labelledby="rule-provider-dialog-title"
      >
        <DialogTitle id="rule-provider-dialog-title">
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            sx={{
              justifyContent: 'space-between',
              alignItems: { sm: 'center' },
            }}
          >
            <Typography variant="h6" sx={{ overflowWrap: 'anywhere' }}>
              {t('rules.page.provider.dialogTitle')}
            </Typography>
            <Button
              variant="contained"
              size="small"
              onClick={updateAllProviders}
              sx={{ alignSelf: { xs: 'flex-start', sm: 'auto' } }}
            >
              {t('rules.page.provider.actions.updateAll')}
            </Button>
          </Stack>
        </DialogTitle>

        <DialogContent
          dividers
          sx={{ minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
        >
          <List sx={{ py: 0, minHeight: 250 }}>
            {Object.entries(ruleProviders || {})
              .sort()
              .map(([key, item]) => {
                const provider = item
                const time = dayjs(provider.updatedAt)
                const isUpdating = updating[key]

                return (
                  <ListItem
                    key={key}
                    sx={[
                      {
                        p: 0,
                        mb: '8px',
                        borderRadius: 2,
                        overflow: 'hidden',
                        transition: 'all 0.2s',
                      },
                      ({ palette: { mode, primary } }) => {
                        const bgcolor = mode === 'light' ? '#ffffff' : '#24252f'
                        const hoverColor =
                          mode === 'light'
                            ? alpha(primary.main, 0.1)
                            : alpha(primary.main, 0.2)

                        return {
                          backgroundColor: bgcolor,
                          '&:hover': {
                            backgroundColor: hoverColor,
                            borderColor: alpha(primary.main, 0.3),
                          },
                        }
                      },
                    ]}
                  >
                    <ListItemText
                      sx={{ px: 2, py: 1, minWidth: 0 }}
                      primary={
                        <Stack
                          direction={{ xs: 'column', sm: 'row' }}
                          spacing={0.5}
                          sx={{
                            justifyContent: 'space-between',
                            alignItems: { sm: 'center' },
                            minWidth: 0,
                          }}
                        >
                          <Stack
                            direction="row"
                            spacing={0.75}
                            sx={{
                              alignItems: 'center',
                              minWidth: 0,
                              flexWrap: 'wrap',
                            }}
                          >
                            <Typography
                              variant="subtitle1"
                              component="div"
                              sx={{
                                minWidth: 0,
                                overflowWrap: 'anywhere',
                                wordBreak: 'break-word',
                              }}
                            >
                              {key}
                            </Typography>
                            <TypeBox component="span">
                              {provider.ruleCount}
                            </TypeBox>
                          </Stack>

                          <Typography
                            variant="body2"
                            sx={{ color: 'text.secondary', flex: '0 0 auto' }}
                          >
                            <small>{t('shared.labels.updateAt')}: </small>
                            {time.fromNow()}
                          </Typography>
                        </Stack>
                      }
                      secondary={
                        <Box
                          sx={{ display: 'flex', flexWrap: 'wrap', mt: 0.5 }}
                        >
                          <TypeBox component="span">
                            {provider.vehicleType}
                          </TypeBox>
                          <TypeBox component="span">
                            {provider.behavior}
                          </TypeBox>
                        </Box>
                      }
                    />
                    <Divider orientation="vertical" flexItem />
                    <Box
                      sx={{
                        width: 44,
                        flex: '0 0 44px',
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                      }}
                    >
                      <IconButton
                        size="small"
                        color="primary"
                        onClick={() => updateProvider(key)}
                        disabled={isUpdating}
                        aria-label={t('rules.page.provider.actions.update')}
                        sx={{
                          animation: isUpdating
                            ? 'spin 1s linear infinite'
                            : 'none',
                          '@keyframes spin': {
                            '0%': { transform: 'rotate(0deg)' },
                            '100%': { transform: 'rotate(360deg)' },
                          },
                        }}
                        title={t('rules.page.provider.actions.update')}
                      >
                        <RefreshRounded />
                      </IconButton>
                    </Box>
                  </ListItem>
                )
              })}
          </List>
        </DialogContent>

        <DialogActions>
          <Button onClick={handleClose} variant="outlined">
            {t('shared.actions.close')}
          </Button>
        </DialogActions>
      </AdaptiveDialog>
    </>
  )
}
