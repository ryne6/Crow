const DEFAULT_AUTHORIZE_ENDPOINT = 'https://auth.openai.com/oauth/authorize'
const DEFAULT_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token'
const DEFAULT_CALLBACK_HOST = '127.0.0.1'
const DEFAULT_CALLBACK_PATH = '/oauth/callback'
const DEFAULT_SCOPES = ['openid', 'profile', 'email', 'offline_access']

export interface OpenAIOAuthRuntimeConfig {
  clientId: string | null
  authorizeEndpoint: string
  tokenEndpoint: string
  userinfoEndpoint: string | null
  scopes: string[]
  callbackHost: string
  callbackPath: string
  callbackPortCandidates: number[]
}

export type OpenAIOAuthEnv = Partial<Record<string, string | undefined>>

function parsePortList(value: string | undefined): number[] {
  if (!value) return []
  const ports = value
    .split(',')
    .map(item => Number(item.trim()))
    .filter(
      port => Number.isInteger(port) && Number.isFinite(port) && port > 0 && port <= 65535
    )
  return [...new Set(ports)]
}

function buildDefaultPortCandidates(): number[] {
  const ports: number[] = []
  for (let port = 1455; port <= 1475; port++) {
    ports.push(port)
  }
  return ports
}

function parseScopes(value: string | undefined): string[] {
  if (!value || value.trim().length === 0) {
    return [...DEFAULT_SCOPES]
  }
  const scopes = value
    .split(/\s+/)
    .map(scope => scope.trim())
    .filter(Boolean)
  return scopes.length > 0 ? scopes : [...DEFAULT_SCOPES]
}

function normalizePath(value: string | undefined): string {
  const path = value?.trim() || DEFAULT_CALLBACK_PATH
  return path.startsWith('/') ? path : `/${path}`
}

function normalizeHost(value: string | undefined): string {
  return value?.trim() || DEFAULT_CALLBACK_HOST
}

export function resolveOpenAIOAuthConfig(
  env: OpenAIOAuthEnv = process.env
): OpenAIOAuthRuntimeConfig {
  const callbackPortCandidates =
    parsePortList(env.OPENAI_OAUTH_CALLBACK_PORTS) || []

  return {
    clientId: env.OPENAI_OAUTH_CLIENT_ID?.trim() || null,
    authorizeEndpoint:
      env.OPENAI_OAUTH_AUTHORIZE_ENDPOINT?.trim() || DEFAULT_AUTHORIZE_ENDPOINT,
    tokenEndpoint: env.OPENAI_OAUTH_TOKEN_ENDPOINT?.trim() || DEFAULT_TOKEN_ENDPOINT,
    userinfoEndpoint: env.OPENAI_OAUTH_USERINFO_ENDPOINT?.trim() || null,
    scopes: parseScopes(env.OPENAI_OAUTH_SCOPES),
    callbackHost: normalizeHost(env.OPENAI_OAUTH_CALLBACK_HOST),
    callbackPath: normalizePath(env.OPENAI_OAUTH_CALLBACK_PATH),
    callbackPortCandidates:
      callbackPortCandidates.length > 0 ? callbackPortCandidates : buildDefaultPortCandidates(),
  }
}

