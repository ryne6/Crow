import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { ProviderService } from '../db/services'
import { isOAuthPlaceholderApiKey } from '../../shared/constants/auth'
import {
  resolveOpenAIOAuthConfig,
  type OpenAIOAuthRuntimeConfig,
} from './openAIOAuthConfig'
import {
  OpenAIOAuthSessionService,
  type OpenAIOAuthLoginSession,
  type OpenAIOAuthLoginStartResult,
} from './openAIOAuthSessionService'

type ProviderAuthType = 'api_key' | 'oauth'

interface ImportedOAuthCredential {
  accessToken: string
  refreshToken?: string
  expiresAtMs?: number
  email?: string
  provider: string
  sourcePath: string
  profileId?: string
}

interface OpenAIOAuthStatus {
  authType: ProviderAuthType
  connected: boolean
  hasAccessToken: boolean
  hasRefreshToken: boolean
  oauthProvider: string | null
  accountEmail: string | null
  expiresAt: string | null
  isExpired: boolean
}

interface ResolvedProviderCredentials {
  apiKey: string
  authType: ProviderAuthType
  oauthProvider: string | null
  accountEmail: string | null
  expiresAt: string | null
}

interface OpenAIOAuthServiceTestOverrides {
  fetchImpl?: typeof fetch
  oauthConfig?: OpenAIOAuthRuntimeConfig
  sessionService?: OpenAIOAuthSessionService | OpenAIOAuthSessionLike
  loginOpenAICodexImpl?: LoginOpenAICodexImpl | null
  openExternalImpl?: ((url: string) => Promise<void>) | null
}

type OpenAIOAuthSessionLike = Pick<
  OpenAIOAuthSessionService,
  | 'startLogin'
  | 'getLoginSession'
  | 'markExchanging'
  | 'markSucceeded'
  | 'markFailed'
  | 'cancelLogin'
  | 'consumeAuthorizationCode'
>

interface CodexOAuthPrompt {
  message: string
  placeholder?: string
}

interface CodexOAuthAuthEvent {
  url: string
}

interface CodexOAuthCredential {
  provider?: string
  access?: string
  refresh?: string
  expires?: number | string
  email?: string
}

type LoginOpenAICodexImpl = (params: {
  onAuth: (event: CodexOAuthAuthEvent) => Promise<void>
  onPrompt: (prompt: CodexOAuthPrompt) => Promise<string>
  onProgress?: (message: string) => void
}) => Promise<CodexOAuthCredential | null>

const OPENCLAW_STATE_DIR_CANDIDATES = [
  '.openclaw',
  '.clawdbot',
  '.moldbot',
  '.moltbot',
]

function parseJsonSafe(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function toStringSafe(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null
}

function toNumberSafe(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function normalizeTimestampMs(value: unknown): number | undefined {
  const numeric = toNumberSafe(value)
  if (!numeric || numeric <= 0) return undefined
  // Support both seconds and milliseconds.
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric
}

function toIsoString(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  const timestamp = date.getTime()
  if (!Number.isFinite(timestamp)) return null
  return date.toISOString()
}

function toDate(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null
  }
  const date = new Date(String(value))
  return Number.isFinite(date.getTime()) ? date : null
}

function isExpiringSoon(expiresAt: unknown): boolean {
  const date = toDate(expiresAt)
  if (!date) return false
  return Date.now() >= date.getTime() - 60_000
}

function decodeBase64Url(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    return Buffer.from(padded, 'base64').toString('utf8')
  } catch {
    return null
  }
}

function extractEmailFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null
  const parts = idToken.split('.')
  if (parts.length < 2) return null
  const payloadJson = decodeBase64Url(parts[1])
  if (!payloadJson) return null
  const payload = parseJsonSafe(payloadJson)
  if (!payload || typeof payload !== 'object') return null
  return toStringSafe((payload as Record<string, unknown>).email)
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return parseJsonSafe(content)
  } catch {
    return null
  }
}

function extractLegacyOauthCandidates(
  payload: unknown,
  sourcePath: string
): ImportedOAuthCredential[] {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const candidates: ImportedOAuthCredential[] = []

  for (const providerKey of ['openai-codex', 'openai']) {
    const cred = record[providerKey]
    if (!cred || typeof cred !== 'object') continue
    const value = cred as Record<string, unknown>
    const accessToken =
      toStringSafe(value.access) ||
      toStringSafe(value.access_token) ||
      toStringSafe(value.token)
    if (!accessToken) continue

    const refreshToken =
      toStringSafe(value.refresh) || toStringSafe(value.refresh_token) || undefined
    const email = toStringSafe(value.email) || undefined
    const expiresAtMs =
      normalizeTimestampMs(value.expires) ||
      normalizeTimestampMs(value.expires_at) ||
      undefined

    candidates.push({
      accessToken,
      refreshToken,
      expiresAtMs,
      email,
      provider: providerKey,
      sourcePath,
    })
  }

  return candidates
}

function extractAuthProfilesCandidates(
  payload: unknown,
  sourcePath: string
): ImportedOAuthCredential[] {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const profilesRaw = record.profiles
  if (!profilesRaw || typeof profilesRaw !== 'object') return []

  const profiles = profilesRaw as Record<string, unknown>
  const candidates: ImportedOAuthCredential[] = []

  for (const [profileId, profileRaw] of Object.entries(profiles)) {
    if (!profileRaw || typeof profileRaw !== 'object') continue
    const profile = profileRaw as Record<string, unknown>
    const provider = toStringSafe(profile.provider)
    const type = toStringSafe(profile.type)

    if (!provider || !provider.startsWith('openai')) continue
    if (type !== 'oauth' && type !== 'token') continue

    const accessToken =
      toStringSafe(profile.access) ||
      toStringSafe(profile.access_token) ||
      toStringSafe(profile.token)
    if (!accessToken) continue

    const refreshToken =
      toStringSafe(profile.refresh) || toStringSafe(profile.refresh_token) || undefined
    const email = toStringSafe(profile.email) || undefined
    const expiresAtMs =
      normalizeTimestampMs(profile.expires) ||
      normalizeTimestampMs(profile.expires_at) ||
      undefined

    candidates.push({
      accessToken,
      refreshToken,
      expiresAtMs,
      email,
      provider,
      sourcePath,
      profileId,
    })
  }

  return candidates
}

function pickBestCredential(
  candidates: ImportedOAuthCredential[]
): ImportedOAuthCredential | null {
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => {
    const aExpires = a.expiresAtMs ?? 0
    const bExpires = b.expiresAtMs ?? 0
    return bExpires - aExpires
  })[0]
}

export class OpenAIOAuthService {
  private static fetchImpl: typeof fetch = fetch

  private static oauthConfigOverride: OpenAIOAuthRuntimeConfig | null = null

  private static loginOpenAICodexOverride: LoginOpenAICodexImpl | null = null

  private static openExternalOverride: ((url: string) => Promise<void>) | null =
    null

  private static sessionServiceOverride:
    | OpenAIOAuthSessionLike
    | OpenAIOAuthSessionService
    | null = null

  private static defaultSessionService: OpenAIOAuthSessionService | null = null
  private static defaultSessionServiceConfigKey: string | null = null

  private static refreshPromiseByProvider = new Map<string, Promise<string>>()

  static setTestOverrides(overrides: OpenAIOAuthServiceTestOverrides = {}) {
    if (overrides.fetchImpl) {
      this.fetchImpl = overrides.fetchImpl
    }
    if (overrides.oauthConfig) {
      this.oauthConfigOverride = overrides.oauthConfig
    }
    if (overrides.sessionService) {
      this.sessionServiceOverride = overrides.sessionService
    }
    if ('loginOpenAICodexImpl' in overrides) {
      this.loginOpenAICodexOverride = overrides.loginOpenAICodexImpl || null
    }
    if ('openExternalImpl' in overrides) {
      this.openExternalOverride = overrides.openExternalImpl || null
    }
  }

  static clearTestOverrides() {
    this.fetchImpl = fetch
    this.oauthConfigOverride = null
    this.sessionServiceOverride = null
    this.defaultSessionService = null
    this.defaultSessionServiceConfigKey = null
    this.refreshPromiseByProvider.clear()
    this.loginOpenAICodexOverride = null
    this.openExternalOverride = null
  }

  private static async openExternal(url: string): Promise<void> {
    if (this.openExternalOverride) {
      await this.openExternalOverride(url)
      return
    }

    const { shell } = await import('electron')
    await shell.openExternal(url)
  }

  private static async getLoginOpenAICodexImpl(): Promise<LoginOpenAICodexImpl> {
    if (this.loginOpenAICodexOverride) {
      return this.loginOpenAICodexOverride
    }

    try {
      const mod = (await import('@mariozechner/pi-ai')) as {
        loginOpenAICodex?: unknown
      }
      if (typeof mod.loginOpenAICodex !== 'function') {
        throw new Error('loginOpenAICodex export is missing')
      }
      return mod.loginOpenAICodex as LoginOpenAICodexImpl
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Codex OAuth bridge unavailable. Install @mariozechner/pi-ai and retry. (${message})`
      )
    }
  }

  private static resolveOAuthConfig(): OpenAIOAuthRuntimeConfig {
    return this.oauthConfigOverride || resolveOpenAIOAuthConfig(process.env)
  }

  private static toOAuthConfigKey(config: OpenAIOAuthRuntimeConfig): string {
    return JSON.stringify({
      clientId: config.clientId || '',
      authorizeEndpoint: config.authorizeEndpoint,
      tokenEndpoint: config.tokenEndpoint,
      userinfoEndpoint: config.userinfoEndpoint || '',
      callbackHost: config.callbackHost,
      callbackPath: config.callbackPath,
      callbackPortCandidates: config.callbackPortCandidates,
      scopes: config.scopes,
    })
  }

  private static getSessionService(): OpenAIOAuthSessionLike {
    if (this.sessionServiceOverride) {
      return this.sessionServiceOverride
    }
    const oauthConfig = this.resolveOAuthConfig()
    const nextConfigKey = this.toOAuthConfigKey(oauthConfig)
    const canReplaceConfig =
      !this.defaultSessionService || !this.defaultSessionService.hasActiveSessions()

    if (
      !this.defaultSessionService ||
      (this.defaultSessionServiceConfigKey !== nextConfigKey && canReplaceConfig)
    ) {
      this.defaultSessionService = new OpenAIOAuthSessionService({
        config: oauthConfig,
        openExternal: async (url: string) => {
          const { shell } = await import('electron')
          await shell.openExternal(url)
        },
      })
      this.defaultSessionServiceConfigKey = nextConfigKey
    }
    return this.defaultSessionService
  }

  private static resolveOpenClawCredentialCandidates(): string[] {
    const filePaths = new Set<string>()
    const home = os.homedir()

    for (const stateDirName of OPENCLAW_STATE_DIR_CANDIDATES) {
      const stateDir = path.join(home, stateDirName)
      filePaths.add(path.join(stateDir, 'credentials', 'oauth.json'))
      filePaths.add(path.join(stateDir, 'auth-profiles.json'))
      filePaths.add(path.join(stateDir, 'agent', 'auth-profiles.json'))
    }

    const envStateDir = toStringSafe(process.env.OPENCLAW_STATE_DIR)
    if (envStateDir) {
      filePaths.add(path.join(envStateDir, 'credentials', 'oauth.json'))
      filePaths.add(path.join(envStateDir, 'auth-profiles.json'))
      filePaths.add(path.join(envStateDir, 'agent', 'auth-profiles.json'))
    }

    const envAgentDir = toStringSafe(process.env.OPENCLAW_AGENT_DIR)
    if (envAgentDir) {
      filePaths.add(path.join(envAgentDir, 'auth-profiles.json'))
    }

    return Array.from(filePaths)
  }

  private static async loadOpenClawCredential(): Promise<ImportedOAuthCredential | null> {
    const candidates: ImportedOAuthCredential[] = []

    for (const filePath of this.resolveOpenClawCredentialCandidates()) {
      const payload = await readJsonFile(filePath)
      if (!payload) continue
      candidates.push(...extractLegacyOauthCandidates(payload, filePath))
      candidates.push(...extractAuthProfilesCandidates(payload, filePath))
    }

    return pickBestCredential(candidates)
  }

  private static async ensureOpenAIProvider(providerId: string) {
    const provider = await ProviderService.getById(providerId)
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`)
    }
    if (provider.type !== 'openai') {
      throw new Error('OAuth login is currently available for OpenAI provider only')
    }
    return provider
  }

  static async startLogin(
    providerId: string,
    clientId?: string | null
  ): Promise<OpenAIOAuthLoginStartResult> {
    await this.ensureOpenAIProvider(providerId)
    const sessionService = this.getSessionService()
    return await sessionService.startLogin(providerId, { clientId })
  }

  static async startCodexLogin(providerId: string): Promise<OpenAIOAuthStatus> {
    const provider = await this.ensureOpenAIProvider(providerId)
    const loginOpenAICodex = await this.getLoginOpenAICodexImpl()
    const fallbackRefreshToken = toStringSafe(provider.oauthRefreshToken)
    const fallbackProvider = toStringSafe(provider.oauthProvider) || 'openai-codex'
    const fallbackEmail = toStringSafe(provider.oauthAccountEmail)

    const credential = await loginOpenAICodex({
      onAuth: async event => {
        const authUrl = toStringSafe(event?.url)
        if (!authUrl) {
          throw new Error('Codex OAuth returned invalid authorization URL')
        }
        await this.openExternal(authUrl)
      },
      onPrompt: async prompt => {
        const promptMessage = toStringSafe(prompt?.message) || 'manual input'
        throw new Error(
          `Codex OAuth requested ${promptMessage}, but manual prompt flow is not supported in Crow desktop yet.`
        )
      },
    })

    if (!credential) {
      throw new Error('Codex OAuth login did not return credentials')
    }

    const accessToken = toStringSafe(credential.access)
    if (!accessToken) {
      throw new Error('Codex OAuth response missing access token')
    }
    const refreshToken = toStringSafe(credential.refresh) || fallbackRefreshToken
    const expiresAtMs = normalizeTimestampMs(credential.expires)
    const oauthProvider = toStringSafe(credential.provider) || fallbackProvider
    const accountEmail = toStringSafe(credential.email) || fallbackEmail

    await ProviderService.setOAuthCredentials(provider.id, {
      oauthAccessToken: accessToken,
      oauthRefreshToken: refreshToken,
      oauthExpiresAt: expiresAtMs ? new Date(expiresAtMs) : null,
      oauthAccountEmail: accountEmail,
      oauthProvider,
    })

    return await this.getOAuthStatus(provider.id)
  }

  static async getLoginSession(sessionId: string): Promise<OpenAIOAuthLoginSession | null> {
    const sessionService = this.getSessionService()
    return sessionService.getLoginSession(sessionId)
  }

  static async pollLoginSession(sessionId: string): Promise<{
    session: OpenAIOAuthLoginSession | null
    oauthStatus: OpenAIOAuthStatus | null
  }> {
    const sessionService = this.getSessionService()
    let session = sessionService.getLoginSession(sessionId)
    if (!session) {
      return { session: null, oauthStatus: null }
    }

    if (session.status === 'code_received') {
      try {
        await this.completeLogin(sessionId)
      } catch {
        // Session status is updated to failed by completeLogin on errors.
      }
      session = sessionService.getLoginSession(sessionId)
    }

    if (!session) {
      return { session: null, oauthStatus: null }
    }

    try {
      const oauthStatus = await this.getOAuthStatus(session.providerId)
      return { session, oauthStatus }
    } catch {
      return { session, oauthStatus: null }
    }
  }

  static async cancelLogin(sessionId: string): Promise<OpenAIOAuthLoginSession | null> {
    const sessionService = this.getSessionService()
    return await sessionService.cancelLogin(sessionId)
  }

  private static async tryFetchUserInfoEmail(accessToken: string): Promise<string | null> {
    const userinfoEndpoint = this.resolveOAuthConfig().userinfoEndpoint
    if (!userinfoEndpoint) return null

    try {
      const response = await this.fetchImpl(userinfoEndpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
      if (!response.ok) return null
      const payload = (await response.json()) as Record<string, unknown>
      return toStringSafe(payload.email)
    } catch {
      return null
    }
  }

  private static async exchangeAuthorizationCode(params: {
    code: string
    codeVerifier: string
    redirectUri: string
    clientId?: string | null
  }): Promise<{
    accessToken: string
    refreshToken: string | null
    expiresAt: Date | null
    accountEmail: string | null
  }> {
    const oauthConfig = this.resolveOAuthConfig()
    const clientId = params.clientId?.trim() || oauthConfig.clientId || ''
    if (!clientId) {
      throw new Error(
        'OpenAI OAuth client_id is required for token exchange. Set OPENAI_OAUTH_CLIENT_ID or provide a client id in settings.'
      )
    }

    const formData = new URLSearchParams()
    formData.set('grant_type', 'authorization_code')
    formData.set('code', params.code)
    formData.set('redirect_uri', params.redirectUri)
    formData.set('client_id', clientId)
    formData.set('code_verifier', params.codeVerifier)

    const response = await this.fetchImpl(oauthConfig.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(
        `OpenAI OAuth token exchange failed (${response.status}): ${text.slice(0, 200)}`
      )
    }

    const payload = (await response.json()) as Record<string, unknown>
    const accessToken =
      toStringSafe(payload.access_token) || toStringSafe(payload.accessToken)
    if (!accessToken) {
      throw new Error('OpenAI OAuth token exchange response missing access token')
    }
    const refreshToken =
      toStringSafe(payload.refresh_token) || toStringSafe(payload.refreshToken) || null
    const expiresIn =
      toNumberSafe(payload.expires_in) || toNumberSafe(payload.expiresIn)
    const expiresAt =
      expiresIn && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null
    const idToken = toStringSafe(payload.id_token) || toStringSafe(payload.idToken)
    const emailFromIdToken = extractEmailFromIdToken(idToken)
    const emailFromUserInfo = await this.tryFetchUserInfoEmail(accessToken)

    return {
      accessToken,
      refreshToken,
      expiresAt,
      accountEmail: emailFromUserInfo || emailFromIdToken || null,
    }
  }

  static async completeLogin(sessionId: string): Promise<OpenAIOAuthLoginSession> {
    const sessionService = this.getSessionService()
    const session = sessionService.getLoginSession(sessionId)
    if (!session) {
      throw new Error(`OAuth session not found: ${sessionId}`)
    }
    if (session.status !== 'code_received') {
      throw new Error('OAuth authorization code is not ready')
    }

    await this.ensureOpenAIProvider(session.providerId)

    sessionService.markExchanging(sessionId)

    try {
      const authCode = sessionService.consumeAuthorizationCode(sessionId)
      const exchanged = await this.exchangeAuthorizationCode({
        code: authCode.code,
        codeVerifier: authCode.codeVerifier,
        redirectUri: authCode.redirectUri,
        clientId: authCode.clientId,
      })

      const provider = await this.ensureOpenAIProvider(session.providerId)
      const fallbackRefreshToken = toStringSafe(provider.oauthRefreshToken)
      await ProviderService.setOAuthCredentials(session.providerId, {
        oauthAccessToken: exchanged.accessToken,
        oauthRefreshToken: exchanged.refreshToken || fallbackRefreshToken,
        oauthExpiresAt: exchanged.expiresAt,
        oauthAccountEmail:
          exchanged.accountEmail || toStringSafe(provider.oauthAccountEmail),
        oauthProvider: toStringSafe(provider.oauthProvider) || 'openai-codex',
      })

      sessionService.markSucceeded(sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionService.markFailed(sessionId, message)
      throw error
    }

    const finalSession = sessionService.getLoginSession(sessionId)
    if (!finalSession) {
      throw new Error('OAuth session missing after completion')
    }
    return finalSession
  }

  static async importFromOpenClaw(providerId: string) {
    const provider = await this.ensureOpenAIProvider(providerId)
    const imported = await this.loadOpenClawCredential()

    if (!imported) {
      throw new Error(
        'No OpenClaw OpenAI OAuth credentials found. Please login in OpenClaw first.'
      )
    }

    await ProviderService.setOAuthCredentials(provider.id, {
      oauthAccessToken: imported.accessToken,
      oauthRefreshToken: imported.refreshToken || null,
      oauthExpiresAt: imported.expiresAtMs
        ? new Date(imported.expiresAtMs)
        : null,
      oauthAccountEmail: imported.email || null,
      oauthProvider: imported.provider,
    })

    return {
      imported: true,
      sourcePath: imported.sourcePath,
      profileId: imported.profileId || null,
      oauthProvider: imported.provider,
      accountEmail: imported.email || null,
      expiresAt: imported.expiresAtMs
        ? new Date(imported.expiresAtMs).toISOString()
        : null,
    }
  }

  static async setManualCredentials(
    providerId: string,
    data: {
      accessToken: string
      refreshToken?: string | null
      expiresAt?: string | null
      accountEmail?: string | null
      oauthProvider?: string | null
    }
  ) {
    const provider = await this.ensureOpenAIProvider(providerId)
    if (!data.accessToken || data.accessToken.trim().length === 0) {
      throw new Error('Access token is required')
    }

    const expiresAt = toDate(data.expiresAt)

    await ProviderService.setOAuthCredentials(provider.id, {
      oauthAccessToken: data.accessToken.trim(),
      oauthRefreshToken: data.refreshToken?.trim() || null,
      oauthExpiresAt: expiresAt,
      oauthAccountEmail: data.accountEmail?.trim() || null,
      oauthProvider: data.oauthProvider?.trim() || 'openai-codex',
    })

    return this.getOAuthStatus(provider.id)
  }

  static async logout(providerId: string) {
    const provider = await this.ensureOpenAIProvider(providerId)
    await ProviderService.clearOAuthCredentials(provider.id)
    return this.getOAuthStatus(provider.id)
  }

  static async getOAuthStatus(providerId: string): Promise<OpenAIOAuthStatus> {
    const provider = await this.ensureOpenAIProvider(providerId)
    const expiresAt = toIsoString(provider.oauthExpiresAt)
    const hasAccessToken = Boolean(provider.oauthAccessToken)

    return {
      authType: (provider.authType || 'api_key') as ProviderAuthType,
      connected:
        (provider.authType || 'api_key') === 'oauth' && hasAccessToken,
      hasAccessToken,
      hasRefreshToken: Boolean(provider.oauthRefreshToken),
      oauthProvider: provider.oauthProvider || null,
      accountEmail: provider.oauthAccountEmail || null,
      expiresAt,
      isExpired: expiresAt ? Date.now() >= new Date(expiresAt).getTime() : false,
    }
  }

  private static async refreshAccessToken(params: {
    refreshToken: string
  }): Promise<{
    accessToken: string
    refreshToken?: string
    expiresAt?: Date
  }> {
    const oauthConfig = this.resolveOAuthConfig()
    const tokenEndpoint = oauthConfig.tokenEndpoint
    const clientId = oauthConfig.clientId

    const formData = new URLSearchParams()
    formData.set('grant_type', 'refresh_token')
    formData.set('refresh_token', params.refreshToken)
    if (clientId) {
      formData.set('client_id', clientId)
    }

    const response = await this.fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    })

    if (!response.ok) {
      const text = await response.text()
      const snippet = text.slice(0, 200)
      if (response.status === 400 && /invalid_grant|invalid_token/i.test(snippet)) {
        throw new Error(`needs_reauth: OpenAI OAuth refresh failed (${response.status}): ${snippet}`)
      }
      if (response.status >= 500) {
        throw new Error(`server_error: OpenAI OAuth refresh failed (${response.status}): ${snippet}`)
      }
      throw new Error(
        `temporary_network_error: OpenAI OAuth refresh failed (${response.status}): ${snippet}`
      )
    }

    const payload = (await response.json()) as Record<string, unknown>
    const accessToken =
      toStringSafe(payload.access_token) || toStringSafe(payload.accessToken)
    if (!accessToken) {
      throw new Error('OpenAI OAuth refresh response missing access token')
    }

    const refreshToken =
      toStringSafe(payload.refresh_token) ||
      toStringSafe(payload.refreshToken) ||
      undefined
    const expiresIn =
      toNumberSafe(payload.expires_in) || toNumberSafe(payload.expiresIn)
    const expiresAt =
      expiresIn && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000)
        : undefined

    return {
      accessToken,
      refreshToken,
      expiresAt,
    }
  }

  private static async ensureValidOpenAIAccessToken(providerId: string) {
    const provider = await this.ensureOpenAIProvider(providerId)
    const accessToken = toStringSafe(provider.oauthAccessToken)
    if (!accessToken) {
      throw new Error('OAuth access token is missing. Please re-login.')
    }

    if (!isExpiringSoon(provider.oauthExpiresAt)) {
      return accessToken
    }

    const refreshToken = toStringSafe(provider.oauthRefreshToken)
    if (!refreshToken) {
      throw new Error('OAuth token expired and refresh token is missing.')
    }

    const inFlight = this.refreshPromiseByProvider.get(providerId)
    if (inFlight) {
      return await inFlight
    }

    const refreshPromise = (async () => {
      const refreshed = await this.refreshAccessToken({ refreshToken })
      await ProviderService.setOAuthCredentials(providerId, {
        oauthAccessToken: refreshed.accessToken,
        oauthRefreshToken: refreshed.refreshToken || refreshToken,
        oauthExpiresAt: refreshed.expiresAt || toDate(provider.oauthExpiresAt),
        oauthAccountEmail: provider.oauthAccountEmail || null,
        oauthProvider: provider.oauthProvider || 'openai-codex',
      })
      return refreshed.accessToken
    })()

    this.refreshPromiseByProvider.set(providerId, refreshPromise)
    try {
      return await refreshPromise
    } finally {
      this.refreshPromiseByProvider.delete(providerId)
    }
  }

  static async resolveProviderCredentials(
    providerId: string
  ): Promise<ResolvedProviderCredentials> {
    const provider = await ProviderService.getById(providerId)
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`)
    }

    // Keep existing behavior for non-OpenAI or API key mode providers.
    if (provider.type !== 'openai' || provider.authType !== 'oauth') {
      if (!provider.apiKey || provider.apiKey.trim().length === 0) {
        throw new Error(`Provider API key missing: ${provider.name}`)
      }
      if (
        provider.type === 'openai' &&
        (provider.authType || 'api_key') === 'api_key' &&
        isOAuthPlaceholderApiKey(provider.apiKey)
      ) {
        throw new Error(
          `Provider API key missing: ${provider.name}. Please enter a valid API key or switch back to OAuth mode.`
        )
      }
      return {
        apiKey: provider.apiKey,
        authType: 'api_key',
        oauthProvider: null,
        accountEmail: null,
        expiresAt: null,
      }
    }

    const apiKey = await this.ensureValidOpenAIAccessToken(providerId)
    const status = await this.getOAuthStatus(providerId)

    return {
      apiKey,
      authType: 'oauth',
      oauthProvider: status.oauthProvider,
      accountEmail: status.accountEmail,
      expiresAt: status.expiresAt,
    }
  }
}

export type { OpenAIOAuthStatus, ResolvedProviderCredentials }
