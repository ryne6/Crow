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

function createProvider() {
  return {
    id: 'provider-1',
    name: 'OpenAI',
    type: 'openai',
    apiKey: 'oauth-placeholder',
    authType: 'oauth',
    oauthAccessToken: 'old-access-token',
    oauthRefreshToken: 'refresh-token',
    oauthExpiresAt: new Date(Date.now() - 60_000),
    oauthAccountEmail: null,
    oauthProvider: 'openai-codex',
  }
}

describe('OpenAIOAuthService refresh flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    OpenAIOAuthService.clearTestOverrides()
  })

  it('should singleflight refresh when resolveProviderCredentials runs concurrently', async () => {
    let provider = createProvider()
    providerServiceMock.getById.mockImplementation(async () => provider)
    providerServiceMock.setOAuthCredentials.mockImplementation(
      async (_providerId: string, data: any) => {
        provider = {
          ...provider,
          oauthAccessToken: data.oauthAccessToken,
          oauthRefreshToken: data.oauthRefreshToken,
          oauthExpiresAt: data.oauthExpiresAt,
          oauthAccountEmail: data.oauthAccountEmail,
          oauthProvider: data.oauthProvider,
        }
      }
    )

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      }),
    }))

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
    })

    const [first, second] = await Promise.all([
      OpenAIOAuthService.resolveProviderCredentials('provider-1'),
      OpenAIOAuthService.resolveProviderCredentials('provider-1'),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(providerServiceMock.setOAuthCredentials).toHaveBeenCalledTimes(1)
    expect(first.apiKey).toBe('new-access-token')
    expect(second.apiKey).toBe('new-access-token')
  })

  it('should classify invalid_grant as needs_reauth', async () => {
    const provider = createProvider()
    providerServiceMock.getById.mockImplementation(async () => provider)

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    }))

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
    })

    await expect(
      OpenAIOAuthService.resolveProviderCredentials('provider-1')
    ).rejects.toThrow('needs_reauth')
  })
})
