export const OAUTH_API_KEY_PLACEHOLDER = 'oauth-placeholder'

export function isOAuthPlaceholderApiKey(value: string | null | undefined): boolean {
  if (!value) return false
  return value.trim() === OAUTH_API_KEY_PLACEHOLDER
}
