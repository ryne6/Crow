import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAIOAuthService } from '../openAIOAuthService'

const providerServiceMock = vi.hoisted(() => ({
  getById: vi.fn(),
  setOAuthCredentials: vi.fn(),
  clearOAuthCredentials: vi.fn(),
}))

vi.mock('../../db/services', () => ({
  ProviderService: providerServiceMock,
}))

function createIdToken(email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
    'base64url'
  )
  const payload = Buffer.from(JSON.stringify({ email })).toString('base64url')
  return `${header}.${payload}.sig`
}

describe('OpenAIOAuthService completeLogin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    OpenAIOAuthService.clearTestOverrides()
  })

  it('should exchange code and persist oauth credentials', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        id_token: createIdToken('user@example.com'),
      }),
    }))

    const sessionService = {
      getLoginSession: vi.fn(() => ({
        sessionId: 'session-1',
        providerId: 'provider-1',
        status: 'code_received',
      })),
      markExchanging: vi.fn(),
      markSucceeded: vi.fn(),
      markFailed: vi.fn(),
      consumeAuthorizationCode: vi.fn(() => ({
        code: 'auth-code',
        codeVerifier: 'code-verifier',
        redirectUri: 'http://127.0.0.1:1455/oauth/callback',
      })),
    }

    providerServiceMock.getById.mockResolvedValue({
      id: 'provider-1',
      type: 'openai',
      oauthRefreshToken: 'old-refresh-token',
    })
    providerServiceMock.setOAuthCredentials.mockResolvedValue(undefined)

    OpenAIOAuthService.setTestOverrides({
      fetchImpl: fetchMock as unknown as typeof fetch,
      oauthConfig: {
        clientId: 'client-id',
        authorizeEndpoint: 'https://auth.openai.com/oauth/authorize',
        tokenEndpoint: 'https://auth.openai.com/oauth/token',
        userinfoEndpoint: null,
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        callbackHost: '127.0.0.1',
        callbackPath: '/oauth/callback',
        callbackPortCandidates: [1455],
      },
      sessionService: sessionService as any,
    })

    await OpenAIOAuthService.completeLogin('session-1')

    expect(sessionService.markExchanging).toHaveBeenCalledWith('session-1')
    expect(providerServiceMock.setOAuthCredentials).toHaveBeenCalledTimes(1)
    expect(providerServiceMock.setOAuthCredentials).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        oauthAccessToken: 'new-access-token',
        oauthRefreshToken: 'new-refresh-token',
        oauthAccountEmail: 'user@example.com',
      })
    )
    expect(sessionService.markSucceeded).toHaveBeenCalledWith('session-1')
  })

  it('should fallback to old refresh token when token response has no refresh token', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        expires_in: 3600,
      }),
    }))

    const sessionService = {
      getLoginSession: vi.fn(() => ({
        sessionId: 'session-2',
        providerId: 'provider-2',
        status: 'code_received',
      })),
      markExchanging: vi.fn(),
      markSucceeded: vi.fn(),
      markFailed: vi.fn(),
      consumeAuthorizationCode: vi.fn(() => ({
        code: 'auth-code-2',
        codeVerifier: 'code-verifier-2',
        redirectUri: 'http://127.0.0.1:1456/oauth/callback',
      })),
    }

    providerServiceMock.getById.mockResolvedValue({
      id: 'provider-2',
      type: 'openai',
      oauthRefreshToken: 'old-refresh-token-2',
    })
    providerServiceMock.setOAuthCredentials.mockResolvedValue(undefined)

    OpenAIOAuthService.setTestOverrides({
      fetchImpl: fetchMock as unknown as typeof fetch,
      oauthConfig: {
        clientId: 'client-id',
        authorizeEndpoint: 'https://auth.openai.com/oauth/authorize',
        tokenEndpoint: 'https://auth.openai.com/oauth/token',
        userinfoEndpoint: null,
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        callbackHost: '127.0.0.1',
        callbackPath: '/oauth/callback',
        callbackPortCandidates: [1455],
      },
      sessionService: sessionService as any,
    })

    await OpenAIOAuthService.completeLogin('session-2')

    expect(providerServiceMock.setOAuthCredentials).toHaveBeenCalledWith(
      'provider-2',
      expect.objectContaining({
        oauthAccessToken: 'new-access-token',
        oauthRefreshToken: 'old-refresh-token-2',
      })
    )
  })

  it('should mark session as failed when token exchange fails', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    }))

    const sessionService = {
      getLoginSession: vi.fn(() => ({
        sessionId: 'session-3',
        providerId: 'provider-3',
        status: 'code_received',
      })),
      markExchanging: vi.fn(),
      markSucceeded: vi.fn(),
      markFailed: vi.fn(),
      consumeAuthorizationCode: vi.fn(() => ({
        code: 'auth-code-3',
        codeVerifier: 'code-verifier-3',
        redirectUri: 'http://127.0.0.1:1457/oauth/callback',
      })),
    }

    providerServiceMock.getById.mockResolvedValue({
      id: 'provider-3',
      type: 'openai',
      oauthRefreshToken: null,
    })

    OpenAIOAuthService.setTestOverrides({
      fetchImpl: fetchMock as unknown as typeof fetch,
      oauthConfig: {
        clientId: 'client-id',
        authorizeEndpoint: 'https://auth.openai.com/oauth/authorize',
        tokenEndpoint: 'https://auth.openai.com/oauth/token',
        userinfoEndpoint: null,
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        callbackHost: '127.0.0.1',
        callbackPath: '/oauth/callback',
        callbackPortCandidates: [1455],
      },
      sessionService: sessionService as any,
    })

    await expect(OpenAIOAuthService.completeLogin('session-3')).rejects.toThrow(
      'OpenAI OAuth token exchange failed'
    )
    expect(sessionService.markFailed).toHaveBeenCalledWith(
      'session-3',
      expect.stringContaining('OpenAI OAuth token exchange failed')
    )
  })
})

describe('OpenAIOAuthService resolveProviderCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    OpenAIOAuthService.clearTestOverrides()
  })

  it('should reject oauth placeholder when provider is in api_key mode', async () => {
    providerServiceMock.getById.mockResolvedValue({
      id: 'provider-api-key-placeholder',
      name: 'OpenAI',
      type: 'openai',
      authType: 'api_key',
      apiKey: 'oauth-placeholder',
    })

    await expect(
      OpenAIOAuthService.resolveProviderCredentials('provider-api-key-placeholder')
    ).rejects.toThrow('Provider API key missing')
  })
})
