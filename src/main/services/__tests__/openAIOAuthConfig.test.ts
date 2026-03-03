import { describe, it, expect } from 'vitest'
import { resolveOpenAIOAuthConfig } from '../openAIOAuthConfig'

describe('resolveOpenAIOAuthConfig', () => {
  it('should provide sane defaults', () => {
    const config = resolveOpenAIOAuthConfig({})

    expect(config.authorizeEndpoint).toBe(
      'https://auth.openai.com/oauth/authorize'
    )
    expect(config.tokenEndpoint).toBe('https://auth.openai.com/oauth/token')
    expect(config.callbackHost).toBe('127.0.0.1')
    expect(config.callbackPath).toBe('/oauth/callback')
    expect(config.scopes).toEqual([
      'openid',
      'profile',
      'email',
      'offline_access',
    ])
    expect(config.callbackPortCandidates[0]).toBe(1455)
    expect(config.callbackPortCandidates.at(-1)).toBe(1475)
  })

  it('should parse callback ports from env', () => {
    const config = resolveOpenAIOAuthConfig({
      OPENAI_OAUTH_CALLBACK_PORTS: '1666,1667, 1668',
    })

    expect(config.callbackPortCandidates).toEqual([1666, 1667, 1668])
  })

  it('should use env overrides for endpoints and client id', () => {
    const config = resolveOpenAIOAuthConfig({
      OPENAI_OAUTH_CLIENT_ID: 'client-123',
      OPENAI_OAUTH_AUTHORIZE_ENDPOINT: 'https://example.com/oauth/authorize',
      OPENAI_OAUTH_TOKEN_ENDPOINT: 'https://example.com/oauth/token',
      OPENAI_OAUTH_USERINFO_ENDPOINT: 'https://example.com/oauth/userinfo',
      OPENAI_OAUTH_SCOPES: 'openid profile custom_scope',
      OPENAI_OAUTH_CALLBACK_HOST: 'localhost',
      OPENAI_OAUTH_CALLBACK_PATH: '/cb',
    })

    expect(config.clientId).toBe('client-123')
    expect(config.authorizeEndpoint).toBe('https://example.com/oauth/authorize')
    expect(config.tokenEndpoint).toBe('https://example.com/oauth/token')
    expect(config.userinfoEndpoint).toBe('https://example.com/oauth/userinfo')
    expect(config.scopes).toEqual(['openid', 'profile', 'custom_scope'])
    expect(config.callbackHost).toBe('localhost')
    expect(config.callbackPath).toBe('/cb')
  })
})
