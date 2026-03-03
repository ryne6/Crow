import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OpenAIOAuthSessionService,
  type OpenAIOAuthSessionState,
} from '../openAIOAuthSessionService'
import type { OpenAIOAuthRuntimeConfig } from '../openAIOAuthConfig'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createTestConfig(port: number): OpenAIOAuthRuntimeConfig {
  return {
    clientId: 'client-test',
    authorizeEndpoint: 'https://auth.openai.com/oauth/authorize',
    tokenEndpoint: 'https://auth.openai.com/oauth/token',
    userinfoEndpoint: null,
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    callbackHost: '127.0.0.1',
    callbackPath: '/oauth/callback',
    callbackPortCandidates: [port],
  }
}

function parseStateFromAuthUrl(authUrl: string): string {
  const state = new URL(authUrl).searchParams.get('state')
  if (!state) {
    throw new Error('state missing in auth url')
  }
  return state
}

describe('OpenAIOAuthSessionService', () => {
  const sessionServices: OpenAIOAuthSessionService[] = []

  afterEach(async () => {
    while (sessionServices.length > 0) {
      const service = sessionServices.pop()
      if (service) {
        await service.dispose()
      }
    }
  })

  it('should start login and open browser url', async () => {
    const openExternal = vi.fn(async () => {})
    const service = new OpenAIOAuthSessionService({
      config: createTestConfig(0),
      openExternal,
      sessionTtlMs: 30_000,
    })
    sessionServices.push(service)

    const started = await service.startLogin('provider-1')
    const session = service.getLoginSession(started.sessionId)

    expect(session).not.toBeNull()
    expect(session?.status).toBe<OpenAIOAuthSessionState>('opened')
    expect(session?.codeVerifier.length).toBeGreaterThan(10)
    expect(session?.codeChallenge.length).toBeGreaterThan(10)
    expect(started.authUrl).toContain('response_type=code')
    expect(started.authUrl).toContain('code_challenge_method=S256')
    expect(started.redirectUri).toContain('http://127.0.0.1:')
    expect(started.redirectUri).not.toContain(':0/')
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('should fail when callback state mismatches', async () => {
    const service = new OpenAIOAuthSessionService({
      config: createTestConfig(0),
      openExternal: async () => {},
      sessionTtlMs: 30_000,
    })
    sessionServices.push(service)

    const started = await service.startLogin('provider-1')
    const mismatchResponse = await service.handleAuthorizationResponse(
      started.sessionId,
      {
        code: 'auth-code',
        state: 'wrong-state',
      }
    )
    expect(mismatchResponse.statusCode).toBe(400)

    const session = service.getLoginSession(started.sessionId)
    expect(session?.status).toBe<OpenAIOAuthSessionState>('failed')
    expect(session?.error).toContain('state')
  })

  it('should store code when callback succeeds', async () => {
    const service = new OpenAIOAuthSessionService({
      config: createTestConfig(0),
      openExternal: async () => {},
      sessionTtlMs: 30_000,
    })
    sessionServices.push(service)

    const started = await service.startLogin('provider-1')
    const state = parseStateFromAuthUrl(started.authUrl)
    const successResponse = await service.handleAuthorizationResponse(
      started.sessionId,
      {
        code: 'auth-code-123',
        state,
      }
    )
    expect(successResponse.statusCode).toBe(200)

    const session = service.getLoginSession(started.sessionId)
    expect(session?.status).toBe<OpenAIOAuthSessionState>('code_received')
    expect(session?.authorizationCode).toBe('auth-code-123')
  })

  it('should timeout if no callback arrives', async () => {
    const service = new OpenAIOAuthSessionService({
      config: createTestConfig(0),
      openExternal: async () => {},
      sessionTtlMs: 30,
    })
    sessionServices.push(service)

    const started = await service.startLogin('provider-1')
    await sleep(80)

    const session = service.getLoginSession(started.sessionId)
    expect(session?.status).toBe<OpenAIOAuthSessionState>('timeout')
  })
})
