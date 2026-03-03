import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { OpenAIOAuthRuntimeConfig } from './openAIOAuthConfig'

export type OpenAIOAuthSessionState =
  | 'pending'
  | 'opened'
  | 'code_received'
  | 'exchanging'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timeout'

export interface OpenAIOAuthLoginSession {
  sessionId: string
  providerId: string
  status: OpenAIOAuthSessionState
  createdAt: string
  expiresAt: string
  authUrl: string
  redirectUri: string
  state: string
  codeVerifier: string
  codeChallenge: string
  authorizationCode: string | null
  error: string | null
}

export interface OpenAIOAuthLoginStartResult {
  sessionId: string
  authUrl: string
  redirectUri: string
  expiresAt: string
}

export interface OpenAIOAuthCallbackParams {
  state?: string | null
  code?: string | null
  error?: string | null
  errorDescription?: string | null
}

type LoginSessionInternal = OpenAIOAuthLoginSession & {
  callbackPort: number
  callbackServer: Server | null
  timeoutHandle: NodeJS.Timeout | null
}

function toBase64Url(value: Buffer): string {
  return value
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function createCodeVerifier(): string {
  return toBase64Url(randomBytes(48))
}

function createCodeChallenge(codeVerifier: string): string {
  const digest = createHash('sha256').update(codeVerifier).digest()
  return toBase64Url(digest)
}

function createStateToken(): string {
  return toBase64Url(randomBytes(24))
}

function createSessionId(): string {
  return randomBytes(16).toString('hex')
}

function isPortRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: string }).code
  return code === 'EADDRINUSE' || code === 'EACCES'
}

function isTerminalState(status: OpenAIOAuthSessionState): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timeout'
  )
}

function toSessionView(session: LoginSessionInternal): OpenAIOAuthLoginSession {
  return {
    sessionId: session.sessionId,
    providerId: session.providerId,
    status: session.status,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    authUrl: session.authUrl,
    redirectUri: session.redirectUri,
    state: session.state,
    codeVerifier: session.codeVerifier,
    codeChallenge: session.codeChallenge,
    authorizationCode: session.authorizationCode,
    error: session.error,
  }
}

export class OpenAIOAuthSessionService {
  private readonly sessions = new Map<string, LoginSessionInternal>()

  private readonly config: OpenAIOAuthRuntimeConfig

  private readonly openExternal: (url: string) => Promise<void>

  private readonly sessionTtlMs: number

  constructor(params: {
    config: OpenAIOAuthRuntimeConfig
    openExternal: (url: string) => Promise<void>
    sessionTtlMs?: number
  }) {
    this.config = params.config
    this.openExternal = params.openExternal
    this.sessionTtlMs = params.sessionTtlMs ?? 180_000
  }

  async startLogin(providerId: string): Promise<OpenAIOAuthLoginStartResult> {
    if (!providerId || providerId.trim().length === 0) {
      throw new Error('providerId is required')
    }
    if (!this.config.clientId) {
      throw new Error('OPENAI_OAUTH_CLIENT_ID is required for OAuth login')
    }

    const sessionId = createSessionId()
    const state = createStateToken()
    const codeVerifier = createCodeVerifier()
    const codeChallenge = createCodeChallenge(codeVerifier)
    const createdAtMs = Date.now()
    const expiresAtMs = createdAtMs + this.sessionTtlMs

    const session: LoginSessionInternal = {
      sessionId,
      providerId,
      status: 'pending',
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      authUrl: '',
      redirectUri: '',
      state,
      codeVerifier,
      codeChallenge,
      authorizationCode: null,
      error: null,
      callbackPort: 0,
      callbackServer: null,
      timeoutHandle: null,
    }

    this.sessions.set(sessionId, session)
    this.armTimeout(session)

    try {
      const { callbackServer, callbackPort } = await this.startCallbackServer(session)
      session.callbackServer = callbackServer
      session.callbackPort = callbackPort
      session.redirectUri = `http://${this.config.callbackHost}:${callbackPort}${this.config.callbackPath}`
      session.authUrl = this.buildAuthorizationUrl(session)

      await this.openExternal(session.authUrl)
      session.status = 'opened'

      return {
        sessionId: session.sessionId,
        authUrl: session.authUrl,
        redirectUri: session.redirectUri,
        expiresAt: session.expiresAt,
      }
    } catch (error) {
      session.status = 'failed'
      session.error =
        error instanceof Error ? error.message : 'Failed to start OAuth login'
      await this.cleanupSessionServer(session)
      throw error
    }
  }

  getLoginSession(sessionId: string): OpenAIOAuthLoginSession | null {
    const session = this.sessions.get(sessionId)
    return session ? toSessionView(session) : null
  }

  markExchanging(sessionId: string): OpenAIOAuthLoginSession | null {
    const session = this.sessions.get(sessionId)
    if (!session || isTerminalState(session.status)) return null
    session.status = 'exchanging'
    return toSessionView(session)
  }

  markSucceeded(sessionId: string): OpenAIOAuthLoginSession | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    session.status = 'succeeded'
    session.error = null
    return toSessionView(session)
  }

  markFailed(sessionId: string, message: string): OpenAIOAuthLoginSession | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    session.status = 'failed'
    session.error = message
    return toSessionView(session)
  }

  async cancelLogin(sessionId: string): Promise<OpenAIOAuthLoginSession | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    if (!isTerminalState(session.status)) {
      session.status = 'cancelled'
      session.error = 'OAuth login cancelled by user'
    }
    await this.cleanupSessionServer(session)
    return toSessionView(session)
  }

  consumeAuthorizationCode(sessionId: string): {
    code: string
    codeVerifier: string
    redirectUri: string
  } {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`OAuth session not found: ${sessionId}`)
    }
    if (session.status !== 'code_received' || !session.authorizationCode) {
      throw new Error('OAuth authorization code is not ready')
    }
    return {
      code: session.authorizationCode,
      codeVerifier: session.codeVerifier,
      redirectUri: session.redirectUri,
    }
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      await this.cleanupSessionServer(session)
    }
    this.sessions.clear()
  }

  async handleAuthorizationResponse(
    sessionId: string,
    params: OpenAIOAuthCallbackParams
  ): Promise<{ statusCode: number; status: OpenAIOAuthSessionState }> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`OAuth session not found: ${sessionId}`)
    }

    const oauthError = params.error?.trim()
    const oauthErrorDescription = params.errorDescription?.trim()
    const state = params.state?.trim()
    const code = params.code?.trim()

    if (oauthError) {
      session.status = 'failed'
      session.error = oauthErrorDescription
        ? `${oauthError}: ${oauthErrorDescription}`
        : oauthError
      await this.cleanupSessionServer(session)
      return { statusCode: 400, status: session.status }
    }

    if (!state || state !== session.state) {
      session.status = 'failed'
      session.error = 'OAuth callback state verification failed'
      await this.cleanupSessionServer(session)
      return { statusCode: 400, status: session.status }
    }

    if (!code) {
      session.status = 'failed'
      session.error = 'OAuth callback missing authorization code'
      await this.cleanupSessionServer(session)
      return { statusCode: 400, status: session.status }
    }

    session.authorizationCode = code
    session.status = 'code_received'
    session.error = null
    await this.cleanupSessionServer(session)
    return { statusCode: 200, status: session.status }
  }

  private buildAuthorizationUrl(session: LoginSessionInternal): string {
    const url = new URL(this.config.authorizeEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.config.clientId || '')
    url.searchParams.set('redirect_uri', session.redirectUri)
    url.searchParams.set('scope', this.config.scopes.join(' '))
    url.searchParams.set('state', session.state)
    url.searchParams.set('code_challenge', session.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    return url.toString()
  }

  private armTimeout(session: LoginSessionInternal): void {
    session.timeoutHandle = setTimeout(() => {
      const current = this.sessions.get(session.sessionId)
      if (!current) return
      if (isTerminalState(current.status)) return
      current.status = 'timeout'
      current.error = 'OAuth login timed out'
      void this.cleanupSessionServer(current)
    }, this.sessionTtlMs)
  }

  private async startCallbackServer(session: LoginSessionInternal): Promise<{
    callbackServer: Server
    callbackPort: number
  }> {
    const server = createServer((request, response) =>
      this.handleCallbackRequest(session, request, response)
    )

    for (const candidatePort of this.config.callbackPortCandidates) {
      try {
        const callbackPort = await this.listenOnPort(
          server,
          candidatePort,
          this.config.callbackHost
        )
        return { callbackServer: server, callbackPort }
      } catch (error) {
        if (!isPortRetryableError(error)) {
          throw error
        }
      }
    }

    throw new Error('Unable to bind OAuth callback server on configured ports')
  }

  private listenOnPort(server: Server, port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onListening = () => {
        cleanup()
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to resolve callback server address'))
          return
        }
        resolve(address.port)
      }
      const cleanup = () => {
        server.off('error', onError)
        server.off('listening', onListening)
      }

      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  }

  private async handleCallbackRequest(
    session: LoginSessionInternal,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const callbackBase = `http://${this.config.callbackHost}:${session.callbackPort}`
    const requestUrl = new URL(request.url || '/', callbackBase)

    if (requestUrl.pathname !== this.config.callbackPath) {
      response.statusCode = 404
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      response.end('Not Found')
      return
    }

    const result = await this.handleAuthorizationResponse(session.sessionId, {
      error: requestUrl.searchParams.get('error'),
      errorDescription: requestUrl.searchParams.get('error_description'),
      state: requestUrl.searchParams.get('state'),
      code: requestUrl.searchParams.get('code'),
    })
    this.writeHtmlResponse(response, result.statusCode === 200)
  }

  private writeHtmlResponse(response: ServerResponse, success: boolean): void {
    response.statusCode = success ? 200 : 400
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(
      success
        ? '<html><body><h2>Login completed</h2><p>You can return to Crow now.</p></body></html>'
        : '<html><body><h2>Login failed</h2><p>Please return to Crow and retry.</p></body></html>'
    )
  }

  private async cleanupSessionServer(session: LoginSessionInternal): Promise<void> {
    if (session.timeoutHandle) {
      clearTimeout(session.timeoutHandle)
      session.timeoutHandle = null
    }
    const server = session.callbackServer
    if (!server) return
    session.callbackServer = null
    if (!server.listening) return
    await new Promise<void>(resolve => {
      server.close(() => resolve())
    })
  }
}
