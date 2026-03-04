import { useEffect, useRef, useState } from 'react'
import { Checkbox, Modal, Select } from '@lobehub/ui'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { isOAuthPlaceholderApiKey } from '~shared/constants/auth'
import {
  dbClient,
  type ProviderModelSyncResult,
  type ProviderOAuthLoginSessionState,
  type ProviderRecord as Provider,
} from '~/services/dbClient'
import { notify } from '~/utils/notify'
import { useSettingsStore } from '~/stores/settingsStore'

interface ProviderConfigDialogProps {
  provider: Provider | null
  open: boolean
  onClose: () => void
  onUpdated: () => void
}

const OPENAI_OAUTH_CLIENT_ID_SETTING_KEY = 'openaiOAuthClientId'

export function ProviderConfigDialog({
  provider,
  open,
  onClose,
  onUpdated,
}: ProviderConfigDialogProps) {
  const normalizeApiKeyForForm = (
    authType: 'api_key' | 'oauth',
    apiKey: string
  ): string => {
    if (authType === 'api_key' && isOAuthPlaceholderApiKey(apiKey)) {
      return ''
    }
    return apiKey
  }

  const { triggerRefresh } = useSettingsStore()
  const [formData, setFormData] = useState({
    name: '',
    apiKey: '',
    baseURL: '',
    apiFormat: 'chat-completions',
    authType: 'api_key' as 'api_key' | 'oauth',
    oauthAutoFetchModels: false,
    modelSyncOnlyCreate: false,
    modelSyncEnableNewModels: true,
    modelSyncNameFilter: '',
    enabled: true,
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [isOAuthActionLoading, setIsOAuthActionLoading] = useState(false)
  const [isModelSyncLoading, setIsModelSyncLoading] = useState(false)
  const [lastModelSyncResult, setLastModelSyncResult] =
    useState<ProviderModelSyncResult | null>(null)
  const [oauthLoginSession, setOauthLoginSession] = useState<{
    sessionId: string
    authUrl: string
    status: ProviderOAuthLoginSessionState
    error: string | null
  } | null>(null)
  const [oauthStatus, setOauthStatus] = useState<{
    connected: boolean
    hasAccessToken: boolean
    hasRefreshToken: boolean
    oauthProvider: string | null
    accountEmail: string | null
    expiresAt: string | null
    isExpired: boolean
  } | null>(null)
  const [manualOAuth, setManualOAuth] = useState({
    accessToken: '',
    refreshToken: '',
    expiresAt: '',
    accountEmail: '',
    oauthProvider: 'openai-codex',
  })
  const [oauthClientId, setOauthClientId] = useState('')
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clearPollingTimer = () => {
    if (!pollingTimerRef.current) return
    clearInterval(pollingTimerRef.current)
    pollingTimerRef.current = null
  }

  const isTerminalLoginStatus = (status: ProviderOAuthLoginSessionState) =>
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timeout'

  const formatLoginStatusLabel = (status: ProviderOAuthLoginSessionState) => {
    switch (status) {
      case 'pending':
        return 'Preparing login'
      case 'opened':
        return 'Waiting for browser authorization'
      case 'code_received':
        return 'Authorization received'
      case 'exchanging':
        return 'Exchanging token'
      case 'succeeded':
        return 'Login completed'
      case 'failed':
        return 'Login failed'
      case 'cancelled':
        return 'Login cancelled'
      case 'timeout':
        return 'Login timed out'
      default:
        return status
    }
  }

  useEffect(() => {
    if (provider) {
      const authType = provider.authType || 'api_key'
      setFormData({
        name: provider.name,
        apiKey: normalizeApiKeyForForm(authType, provider.apiKey),
        baseURL: provider.baseURL || '',
        apiFormat: provider.apiFormat || 'chat-completions',
        authType,
        oauthAutoFetchModels: provider.oauthAutoFetchModels || false,
        modelSyncOnlyCreate: provider.modelSyncOnlyCreate || false,
        modelSyncEnableNewModels:
          provider.modelSyncEnableNewModels !== false,
        modelSyncNameFilter: provider.modelSyncNameFilter || '',
        enabled: provider.enabled,
      })
    }
  }, [provider])

  const loadOAuthStatus = async () => {
    if (!provider || provider.type !== 'openai') return
    try {
      const status = await dbClient.providers.oauthStatus(provider.id)
      setOauthStatus(status)
    } catch (error) {
      console.error('Failed to load OpenAI OAuth status:', error)
      setOauthStatus(null)
    }
  }

  useEffect(() => {
    if (!open || !provider || provider.type !== 'openai') return
    loadOAuthStatus()
    void (async () => {
      try {
        const value = await dbClient.settings.get(OPENAI_OAUTH_CLIENT_ID_SETTING_KEY)
        setOauthClientId(typeof value === 'string' ? value : '')
      } catch (error) {
        console.error('Failed to load OpenAI OAuth client id setting:', error)
      }
    })()
  }, [open, provider?.id])

  useEffect(() => {
    if (open) return
    clearPollingTimer()
    setOauthLoginSession(null)
    setLastModelSyncResult(null)
    setOauthClientId('')
  }, [open])

  useEffect(() => {
    return () => clearPollingTimer()
  }, [])

  const syncProviderModels = async (
    source: 'manual' | 'auto' | 'preview'
  ): Promise<ProviderModelSyncResult | null> => {
    if (!provider) return null
    setIsModelSyncLoading(true)
    try {
      const syncOptions = {
        onlyCreateNew: formData.modelSyncOnlyCreate,
        enableNewModels: formData.modelSyncEnableNewModels,
        nameFilter: formData.modelSyncNameFilter.trim() || null,
      } as {
        onlyCreateNew: boolean
        enableNewModels: boolean
        nameFilter: string | null
        dryRun?: boolean
      }
      if (source === 'preview') {
        syncOptions.dryRun = true
      }

      const result = await dbClient.providers.fetchModels(provider.id, syncOptions)
      setLastModelSyncResult(result)
      const summary =
        source === 'preview'
          ? `fetched ${result.discovered}, would add ${result.created}, would update ${result.updated}, filtered ${result.filteredOut}`
          : `fetched ${result.discovered}, new ${result.created}, updated ${result.updated}, filtered ${result.filteredOut}`
      if (source === 'preview') {
        notify.success(`Model sync preview: ${summary}`)
      } else if (source === 'manual') {
        notify.success(`Models synced: ${summary}`)
      } else {
        notify.success(`OAuth login succeeded. Auto-synced models: ${summary}`)
      }
      if (source !== 'preview') {
        triggerRefresh()
        onUpdated()
      }
      return result
    } catch (error) {
      console.error('Failed to sync provider models:', error)
      notify.error(
        error instanceof Error ? error.message : 'Failed to fetch models'
      )
      return null
    } finally {
      setIsModelSyncLoading(false)
    }
  }

  const handleFetchModels = async () => {
    await syncProviderModels('manual')
  }

  const handlePreviewModels = async () => {
    await syncProviderModels('preview')
  }

  const renderLastModelSyncResult = () => {
    if (!lastModelSyncResult) return null

    const summaryPrefix = lastModelSyncResult.dryRun
      ? 'Last preview'
      : 'Last model sync'
    const createdLabel = lastModelSyncResult.dryRun ? 'would add' : 'new'
    const updatedLabel = lastModelSyncResult.dryRun
      ? 'would update'
      : 'updated'

    return (
      <div className="text-xs text-muted-foreground space-y-1">
        <div>
          {summaryPrefix}: fetched {lastModelSyncResult.discovered}, {createdLabel}{' '}
          {lastModelSyncResult.created}, {updatedLabel} {lastModelSyncResult.updated},
          filtered {lastModelSyncResult.filteredOut}
        </div>
        {lastModelSyncResult.dryRun && (
          <div>
            Plan: add{' '}
            {lastModelSyncResult.toCreate.length > 0
              ? lastModelSyncResult.toCreate.join(', ')
              : 'none'}
            ; rename{' '}
            {lastModelSyncResult.toUpdate.length > 0
              ? lastModelSyncResult.toUpdate.join(', ')
              : 'none'}
          </div>
        )}
      </div>
    )
  }

  const pollOAuthLoginSession = async (
    sessionId: string
  ): Promise<ProviderOAuthLoginSessionState | null> => {
    try {
      const result = await dbClient.providers.oauthGetLoginSession(sessionId)
      const session = result.session
      if (!session) {
        clearPollingTimer()
        return null
      }

      if (result.oauthStatus) {
        setOauthStatus(result.oauthStatus)
      }

      setOauthLoginSession(prev => ({
        sessionId,
        authUrl: prev?.authUrl || session.authUrl,
        status: session.status,
        error: session.error,
      }))

      if (!isTerminalLoginStatus(session.status)) {
        return session.status
      }

      clearPollingTimer()
      if (session.status === 'succeeded') {
        setFormData(prev => ({ ...prev, authType: 'oauth' }))
        await loadOAuthStatus()
        if (formData.oauthAutoFetchModels) {
          await syncProviderModels('auto')
        } else {
          notify.success('OAuth login succeeded')
          triggerRefresh()
          onUpdated()
        }
      } else if (session.status === 'failed') {
        notify.error(session.error || 'OAuth login failed')
      } else if (session.status === 'timeout') {
        notify.error('OAuth login timed out')
      }
      return session.status
    } catch (error) {
      clearPollingTimer()
      console.error('Failed to poll OAuth login session:', error)
      notify.error(
        error instanceof Error ? error.message : 'Failed to check OAuth login status'
      )
      return null
    }
  }

  const handleStartOAuthLogin = async () => {
    if (!provider) return
    setIsOAuthActionLoading(true)
    try {
      const normalizedClientId = oauthClientId.trim()
      await dbClient.settings.set(
        OPENAI_OAUTH_CLIENT_ID_SETTING_KEY,
        normalizedClientId || null
      )
      const started = await dbClient.providers.oauthStartLogin(
        provider.id,
        normalizedClientId || null
      )
      setOauthLoginSession({
        sessionId: started.sessionId,
        authUrl: started.authUrl,
        status: 'opened',
        error: null,
      })
      clearPollingTimer()
      const initialStatus = await pollOAuthLoginSession(started.sessionId)
      if (initialStatus && !isTerminalLoginStatus(initialStatus)) {
        pollingTimerRef.current = setInterval(() => {
          void pollOAuthLoginSession(started.sessionId)
        }, 1200)
      }
    } catch (error) {
      console.error('Failed to start OAuth login:', error)
      notify.error(error instanceof Error ? error.message : 'Failed to start OAuth login')
    } finally {
      setIsOAuthActionLoading(false)
    }
  }

  const handleStartCodexOAuthLogin = async () => {
    if (!provider) return
    setIsOAuthActionLoading(true)
    try {
      clearPollingTimer()
      setOauthLoginSession(null)
      const status = await dbClient.providers.oauthStartCodexLogin(provider.id)
      setOauthStatus(status)
      setFormData(prev => ({ ...prev, authType: 'oauth' }))
      if (formData.oauthAutoFetchModels) {
        await syncProviderModels('auto')
      } else {
        notify.success(
          status.accountEmail
            ? `Codex OAuth login succeeded (${status.accountEmail})`
            : 'Codex OAuth login succeeded'
        )
        triggerRefresh()
        onUpdated()
      }
    } catch (error) {
      console.error('Failed to start Codex OAuth login:', error)
      notify.error(
        error instanceof Error ? error.message : 'Failed to start Codex OAuth login'
      )
    } finally {
      setIsOAuthActionLoading(false)
    }
  }

  const handleCancelOAuthLogin = async () => {
    if (!oauthLoginSession) return
    setIsOAuthActionLoading(true)
    try {
      const cancelled = await dbClient.providers.oauthCancelLogin(
        oauthLoginSession.sessionId
      )
      clearPollingTimer()
      if (cancelled) {
        setOauthLoginSession({
          sessionId: cancelled.sessionId,
          authUrl: cancelled.authUrl,
          status: cancelled.status,
          error: cancelled.error,
        })
      } else {
        setOauthLoginSession(null)
      }
      notify.success('OAuth login cancelled')
    } catch (error) {
      console.error('Failed to cancel OAuth login:', error)
      notify.error(error instanceof Error ? error.message : 'Failed to cancel OAuth login')
    } finally {
      setIsOAuthActionLoading(false)
    }
  }

  const handleImportOpenClaw = async () => {
    if (!provider) return
    setIsOAuthActionLoading(true)
    try {
      const result = await dbClient.providers.oauthImportOpenClaw(provider.id)
      notify.success(
        result.accountEmail
          ? `OAuth imported (${result.accountEmail})`
          : 'OAuth imported from OpenClaw'
      )
      setFormData(prev => ({ ...prev, authType: 'oauth' }))
      await loadOAuthStatus()
      triggerRefresh()
      onUpdated()
    } catch (error) {
      console.error('Failed to import OpenClaw OAuth:', error)
      notify.error(
        error instanceof Error ? error.message : 'Failed to import OAuth'
      )
    } finally {
      setIsOAuthActionLoading(false)
    }
  }

  const handleSaveManualOAuth = async () => {
    if (!provider) return
    if (!manualOAuth.accessToken.trim()) {
      notify.error('Access token is required')
      return
    }

    setIsOAuthActionLoading(true)
    try {
      const status = await dbClient.providers.oauthSetManual(provider.id, {
        accessToken: manualOAuth.accessToken.trim(),
        refreshToken: manualOAuth.refreshToken.trim() || null,
        expiresAt: manualOAuth.expiresAt || null,
        accountEmail: manualOAuth.accountEmail.trim() || null,
        oauthProvider: manualOAuth.oauthProvider.trim() || null,
      })
      setOauthStatus(status)
      setFormData(prev => ({ ...prev, authType: 'oauth' }))
      notify.success('OAuth tokens saved')
      triggerRefresh()
      onUpdated()
    } catch (error) {
      console.error('Failed to save manual OAuth tokens:', error)
      notify.error(error instanceof Error ? error.message : 'Failed to save OAuth')
    } finally {
      setIsOAuthActionLoading(false)
    }
  }

  const handleLogoutOAuth = async () => {
    if (!provider) return
    setIsOAuthActionLoading(true)
    try {
      const status = await dbClient.providers.oauthLogout(provider.id)
      setOauthStatus(status)
      notify.success('OAuth disconnected')
      triggerRefresh()
      onUpdated()
    } catch (error) {
      console.error('Failed to disconnect OAuth:', error)
      notify.error(
        error instanceof Error ? error.message : 'Failed to disconnect OAuth'
      )
    } finally {
      setIsOAuthActionLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!provider || !formData.name.trim()) {
      notify.error('Name is required')
      return
    }

    if (formData.authType === 'api_key' && !formData.apiKey.trim()) {
      notify.error('API Key is required for API key auth mode')
      return
    }

    setIsSubmitting(true)
    try {
      const updatePayload: Record<string, unknown> = {
        name: formData.name.trim(),
        baseURL: formData.baseURL || null,
        apiFormat: formData.apiFormat,
        authType: formData.authType,
        oauthAutoFetchModels: formData.oauthAutoFetchModels,
        modelSyncOnlyCreate: formData.modelSyncOnlyCreate,
        modelSyncEnableNewModels: formData.modelSyncEnableNewModels,
        modelSyncNameFilter: formData.modelSyncNameFilter.trim() || null,
        enabled: formData.enabled,
      }

      if (formData.authType === 'api_key') {
        updatePayload.apiKey = formData.apiKey.trim()
      }

      await dbClient.providers.update(provider.id, {
        ...updatePayload,
      })
      if (provider.type === 'openai') {
        const normalizedClientId = oauthClientId.trim()
        await dbClient.settings.set(
          OPENAI_OAUTH_CLIENT_ID_SETTING_KEY,
          normalizedClientId || null
        )
      }

      notify.success(`${provider.name} updated successfully`)
      triggerRefresh()
      onClose()
      onUpdated()
    } catch (error) {
      console.error('Failed to update provider:', error)
      notify.error('Failed to update provider')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!provider) return null

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={`Configure ${provider.name}`}
      footer={null}
      width={500}
    >
      <p className="text-sm text-muted-foreground mb-4">
        Update your provider settings
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            className="text-sm font-medium mb-2 block"
            htmlFor="provider-name"
          >
            Name <span className="text-destructive">*</span>
          </label>
          <Input
            id="provider-name"
            type="text"
            value={formData.name}
            onChange={e => setFormData({ ...formData, name: e.target.value })}
            placeholder="my-provider"
            required
          />
        </div>

        <div>
          <label
            className="text-sm font-medium mb-2 block"
            htmlFor="provider-api-key"
          >
            API Key{' '}
            {formData.authType === 'api_key' && (
              <span className="text-destructive">*</span>
            )}
          </label>
          <div className="relative">
            <Input
              id="provider-api-key"
              type={showApiKey ? 'text' : 'password'}
              value={formData.apiKey}
              onChange={e =>
                setFormData({ ...formData, apiKey: e.target.value })
              }
              placeholder="sk-..."
              className="pr-20 font-mono"
              required={formData.authType === 'api_key'}
              disabled={formData.authType === 'oauth'}
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
            >
              {showApiKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {formData.authType === 'oauth'
              ? 'Disabled in OAuth mode'
              : 'Your API key is encrypted and stored securely'}
          </p>
        </div>

        {provider.type === 'openai' && (
          <div>
            <label
              className="text-sm font-medium mb-2 block"
              htmlFor="provider-auth-type"
            >
              Auth Mode
            </label>
            <Select
              id="provider-auth-type"
              value={formData.authType}
              onChange={value =>
                setFormData({
                  ...formData,
                  authType: value as 'api_key' | 'oauth',
                })
              }
              style={{ width: '100%' }}
              options={[
                { value: 'api_key', label: 'API Key' },
                { value: 'oauth', label: 'OAuth (ChatGPT account)' },
              ]}
            />
          </div>
        )}

        {provider.type === 'openai' && formData.authType === 'oauth' && (
          <div className="rounded-lg border p-3 space-y-3">
            <div>
              <div className="text-sm font-medium">OAuth Client ID Override</div>
              <Input
                type="text"
                value={oauthClientId}
                onChange={e => setOauthClientId(e.target.value)}
                placeholder="Leave empty to use OPENAI_OAUTH_CLIENT_ID"
                className="font-mono mt-2"
              />
              <div className="text-xs text-muted-foreground mt-1">
                Optional. If empty, Crow reads `OPENAI_OAUTH_CLIENT_ID` from environment.
              </div>
            </div>

            <div>
              <div className="text-sm font-medium">OpenAI OAuth Status</div>
              <div className="text-xs text-muted-foreground mt-1 space-y-1">
                <div>
                  {oauthStatus?.connected ? 'Connected' : 'Not connected'}
                  {oauthStatus?.isExpired ? ' (expired)' : ''}
                </div>
                {oauthStatus?.accountEmail && (
                  <div>Account: {oauthStatus.accountEmail}</div>
                )}
                {oauthStatus?.expiresAt && (
                  <div>
                    Expires: {new Date(oauthStatus.expiresAt).toLocaleString()}
                  </div>
                )}
                {oauthStatus?.oauthProvider && (
                  <div>Provider: {oauthStatus.oauthProvider}</div>
                )}
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                htmlType="button"
                onClick={handleStartCodexOAuthLogin}
                disabled={isOAuthActionLoading}
              >
                Sign in with Codex
              </Button>
              <Button
                htmlType="button"
                variant="outline"
                onClick={handleStartOAuthLogin}
                disabled={isOAuthActionLoading}
              >
                Sign in with ChatGPT
              </Button>
              <Button
                htmlType="button"
                variant="outline"
                onClick={handleImportOpenClaw}
                disabled={isOAuthActionLoading}
              >
                Import from OpenClaw
              </Button>
              <Button
                htmlType="button"
                variant="outline"
                onClick={handleLogoutOAuth}
                disabled={isOAuthActionLoading}
              >
                Disconnect OAuth
              </Button>
              <Button
                htmlType="button"
                variant="outline"
                onClick={handlePreviewModels}
                disabled={isModelSyncLoading || isOAuthActionLoading}
              >
                {isModelSyncLoading ? 'Previewing...' : 'Preview Sync'}
              </Button>
              <Button
                htmlType="button"
                variant="outline"
                onClick={handleFetchModels}
                disabled={isModelSyncLoading || isOAuthActionLoading}
              >
                {isModelSyncLoading ? 'Fetching...' : 'Fetch Models'}
              </Button>
            </div>

            <div className="text-xs">
              <Checkbox
                checked={formData.oauthAutoFetchModels}
                onChange={checked =>
                  setFormData({
                    ...formData,
                    oauthAutoFetchModels: checked,
                  })
                }
              >
                Auto fetch models after OAuth login
              </Checkbox>
            </div>

            <div className="space-y-2 text-xs">
              <Checkbox
                checked={formData.modelSyncOnlyCreate}
                onChange={checked =>
                  setFormData({
                    ...formData,
                    modelSyncOnlyCreate: checked,
                  })
                }
              >
                Only add new models (do not rename existing)
              </Checkbox>
              <Checkbox
                checked={formData.modelSyncEnableNewModels}
                onChange={checked =>
                  setFormData({
                    ...formData,
                    modelSyncEnableNewModels: checked,
                  })
                }
              >
                Auto-enable newly fetched models
              </Checkbox>
              <Input
                type="text"
                placeholder="Name filter (comma-separated keywords)"
                value={formData.modelSyncNameFilter}
                onChange={e =>
                  setFormData({
                    ...formData,
                    modelSyncNameFilter: e.target.value,
                  })
                }
              />
            </div>

            {renderLastModelSyncResult()}

            {oauthLoginSession && (
              <div className="rounded border p-2 text-xs space-y-2">
                <div>
                  Login: {formatLoginStatusLabel(oauthLoginSession.status)}
                  {oauthLoginSession.error ? ` (${oauthLoginSession.error})` : ''}
                </div>
                <div className="flex gap-2">
                  <Button
                    htmlType="button"
                    variant="outline"
                    onClick={() => window.open(oauthLoginSession.authUrl, '_blank')}
                    disabled={isOAuthActionLoading}
                  >
                    Open Browser Manually
                  </Button>
                  {!isTerminalLoginStatus(oauthLoginSession.status) && (
                    <Button
                      htmlType="button"
                      variant="outline"
                      onClick={handleCancelOAuthLogin}
                      disabled={isOAuthActionLoading}
                    >
                      Cancel Login
                    </Button>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                Manual OAuth Token (fallback)
              </div>
              <Input
                type="password"
                placeholder="Access Token"
                value={manualOAuth.accessToken}
                onChange={e =>
                  setManualOAuth({
                    ...manualOAuth,
                    accessToken: e.target.value,
                  })
                }
                className="font-mono"
              />
              <Input
                type="password"
                placeholder="Refresh Token (optional)"
                value={manualOAuth.refreshToken}
                onChange={e =>
                  setManualOAuth({
                    ...manualOAuth,
                    refreshToken: e.target.value,
                  })
                }
                className="font-mono"
              />
              <Input
                type="datetime-local"
                value={manualOAuth.expiresAt}
                onChange={e =>
                  setManualOAuth({
                    ...manualOAuth,
                    expiresAt: e.target.value,
                  })
                }
              />
              <Input
                type="text"
                placeholder="Account Email (optional)"
                value={manualOAuth.accountEmail}
                onChange={e =>
                  setManualOAuth({
                    ...manualOAuth,
                    accountEmail: e.target.value,
                  })
                }
              />
              <Button
                htmlType="button"
                variant="outline"
                onClick={handleSaveManualOAuth}
                disabled={isOAuthActionLoading}
              >
                Save OAuth Tokens
              </Button>
            </div>
          </div>
        )}

        <div>
          <label
            className="text-sm font-medium mb-2 block"
            htmlFor="provider-base-url"
          >
            Base URL
          </label>
          <Input
            id="provider-base-url"
            type="text"
            value={formData.baseURL}
            onChange={e =>
              setFormData({ ...formData, baseURL: e.target.value })
            }
            placeholder="https://api.example.com/v1"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Optional: Custom API endpoint
          </p>
        </div>

        <div>
          <label
            className="text-sm font-medium mb-2 block"
            htmlFor="provider-api-format"
          >
            API Format
          </label>
          <Select
            id="provider-api-format"
            value={formData.apiFormat}
            onChange={value => setFormData({ ...formData, apiFormat: value })}
            style={{ width: '100%' }}
            options={[
              {
                value: 'chat-completions',
                label: 'Chat Completions (/chat/completions)',
              },
              { value: 'responses', label: 'Responses (/responses)' },
              {
                value: 'anthropic-messages',
                label: 'Anthropic Messages (/v1/messages)',
              },
            ]}
          />
        </div>

        {!(provider.type === 'openai' && formData.authType === 'oauth') && (
          <div className="rounded-lg border p-3 space-y-2">
            <div className="text-sm font-medium">Model Sync</div>
            <div className="text-xs text-muted-foreground">
              Fetch available models from provider API and merge into local model list
            </div>
            <div className="space-y-2 text-xs">
              <Checkbox
                checked={formData.modelSyncOnlyCreate}
                onChange={checked =>
                  setFormData({
                    ...formData,
                    modelSyncOnlyCreate: checked,
                  })
                }
              >
                Only add new models (do not rename existing)
              </Checkbox>
              <Checkbox
                checked={formData.modelSyncEnableNewModels}
                onChange={checked =>
                  setFormData({
                    ...formData,
                    modelSyncEnableNewModels: checked,
                  })
                }
              >
                Auto-enable newly fetched models
              </Checkbox>
              <Input
                type="text"
                placeholder="Name filter (comma-separated keywords)"
                value={formData.modelSyncNameFilter}
                onChange={e =>
                  setFormData({
                    ...formData,
                    modelSyncNameFilter: e.target.value,
                  })
                }
              />
            </div>
            <div className="flex gap-2">
              <Button
                htmlType="button"
                variant="outline"
                onClick={handlePreviewModels}
                disabled={isModelSyncLoading}
              >
                {isModelSyncLoading ? 'Previewing...' : 'Preview Sync'}
              </Button>
              <Button
                htmlType="button"
                variant="outline"
                onClick={handleFetchModels}
                disabled={isModelSyncLoading}
              >
                {isModelSyncLoading ? 'Fetching...' : 'Fetch Models'}
              </Button>
            </div>
            {renderLastModelSyncResult()}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Checkbox
            checked={formData.enabled}
            onChange={checked => setFormData({ ...formData, enabled: checked })}
          >
            Enabled
          </Checkbox>
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <Button htmlType="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button htmlType="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
