import { eq } from 'drizzle-orm'
import { getDatabase, schema } from '../index'
import type { NewProvider } from '../schema'
import { generateId } from '../utils/idGenerator'
import crypto from 'crypto'
import { OAUTH_API_KEY_PLACEHOLDER } from '../../../shared/constants/auth'

const { providers } = schema

// Simple encryption for API keys (in production, use proper key management)
const ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ||
  'crow-default-encryption-key-change-me-in-production'
const ALGORITHM = 'aes-256-cbc'

function encrypt(text: string): string {
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return iv.toString('hex') + ':' + encrypted
}

function decrypt(text: string): string {
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32)
  const parts = text.split(':')
  const iv = Buffer.from(parts[0], 'hex')
  const encrypted = parts[1]
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

function safeDecrypt(text: string): string {
  try {
    if (!text.includes(':')) return text
    return decrypt(text)
  } catch {
    // Backward compatibility: keep raw value instead of failing hard.
    return text
  }
}

function encryptOptional(text?: string | null): string | null {
  if (!text) return null
  return encrypt(text)
}

function decryptOptional(text?: string | null): string | null {
  if (!text) return null
  return safeDecrypt(text)
}

export class ProviderService {
  private static toDecryptedProvider(provider: any) {
    return {
      ...provider,
      authType: provider.authType || 'api_key',
      oauthAutoFetchModels: provider.oauthAutoFetchModels ?? false,
      modelSyncOnlyCreate: provider.modelSyncOnlyCreate ?? false,
      modelSyncEnableNewModels: provider.modelSyncEnableNewModels ?? true,
      modelSyncNameFilter: provider.modelSyncNameFilter || null,
      apiKey: safeDecrypt(provider.apiKey),
      oauthAccessToken: decryptOptional(provider.oauthAccessToken),
      oauthRefreshToken: decryptOptional(provider.oauthRefreshToken),
    }
  }

  private static async getRawById(id: string) {
    const db = getDatabase()
    const result = await db
      .select()
      .from(providers)
      .where(eq(providers.id, id))
      .limit(1)
    return result[0] ?? null
  }

  // Get all providers
  static async getAll() {
    const db = getDatabase()
    const allProviders = await db.select().from(providers)

    return allProviders.map(provider => this.toDecryptedProvider(provider))
  }

  // Get enabled providers only
  static async getEnabled() {
    const db = getDatabase()
    const enabledProviders = await db
      .select()
      .from(providers)
      .where(eq(providers.enabled, true))

    return enabledProviders.map(provider => this.toDecryptedProvider(provider))
  }

  // Get provider by ID
  static async getById(id: string) {
    const db = getDatabase()
    const result = await db
      .select()
      .from(providers)
      .where(eq(providers.id, id))
      .limit(1)

    if (!result[0]) return null

    return this.toDecryptedProvider(result[0])
  }

  // Get provider by name
  static async getByName(name: string) {
    const db = getDatabase()
    const result = await db
      .select()
      .from(providers)
      .where(eq(providers.name, name))
      .limit(1)

    if (!result[0]) return null

    return this.toDecryptedProvider(result[0])
  }

  // Create provider
  static async create(data: Omit<NewProvider, 'id' | 'createdAt'>) {
    const db = getDatabase()
    const authType = data.authType || 'api_key'
    const effectiveApiKey =
      data.apiKey && data.apiKey.trim().length > 0
        ? data.apiKey
        : authType === 'oauth'
          ? OAUTH_API_KEY_PLACEHOLDER
          : ''

    if (!effectiveApiKey) {
      throw new Error('API key is required for api_key auth mode')
    }

    const newProvider: NewProvider = {
      id: generateId(),
      name: data.name,
      type: data.type,
      apiKey: encrypt(effectiveApiKey), // Encrypt API key
      baseURL: data.baseURL || null,
      apiFormat: data.apiFormat || 'chat-completions',
      authType,
      oauthAutoFetchModels: data.oauthAutoFetchModels ?? false,
      modelSyncOnlyCreate: data.modelSyncOnlyCreate ?? false,
      modelSyncEnableNewModels: data.modelSyncEnableNewModels ?? true,
      modelSyncNameFilter: data.modelSyncNameFilter || null,
      oauthProvider: data.oauthProvider || null,
      oauthAccessToken: encryptOptional(data.oauthAccessToken),
      oauthRefreshToken: encryptOptional(data.oauthRefreshToken),
      oauthExpiresAt: data.oauthExpiresAt || null,
      oauthAccountEmail: data.oauthAccountEmail || null,
      enabled: data.enabled ?? true,
      createdAt: new Date(),
    }

    await db.insert(providers).values(newProvider)

    return {
      ...newProvider,
      apiKey: effectiveApiKey, // Return unencrypted
      apiFormat: data.apiFormat || 'chat-completions',
      oauthAutoFetchModels: data.oauthAutoFetchModels ?? false,
      modelSyncOnlyCreate: data.modelSyncOnlyCreate ?? false,
      modelSyncEnableNewModels: data.modelSyncEnableNewModels ?? true,
      modelSyncNameFilter: data.modelSyncNameFilter || null,
      oauthAccessToken: data.oauthAccessToken || null,
      oauthRefreshToken: data.oauthRefreshToken || null,
    }
  }

  // Update provider
  static async update(
    id: string,
    data: Partial<Omit<NewProvider, 'id' | 'createdAt'>>
  ) {
    const db = getDatabase()
    const existing = await this.getRawById(id)
    if (!existing) return null

    const updateData: Partial<Omit<NewProvider, 'id' | 'createdAt'>> = {
      ...data,
    }

    // Encrypt API key if provided. In OAuth mode we keep a non-empty placeholder.
    if (typeof data.apiKey === 'string' && data.apiKey.trim().length > 0) {
      updateData.apiKey = encrypt(data.apiKey)
    } else if (data.authType === 'oauth') {
      const existingApiKey = safeDecrypt(existing.apiKey || '')
      const fallbackKey =
        existingApiKey.trim().length > 0
          ? existingApiKey
          : OAUTH_API_KEY_PLACEHOLDER
      updateData.apiKey = encrypt(fallbackKey)
    }

    if ('oauthAccessToken' in data) {
      updateData.oauthAccessToken = encryptOptional(data.oauthAccessToken)
    }

    if ('oauthRefreshToken' in data) {
      updateData.oauthRefreshToken = encryptOptional(data.oauthRefreshToken)
    }

    await db.update(providers).set(updateData).where(eq(providers.id, id))

    return this.getById(id)
  }

  static async setOAuthCredentials(
    id: string,
    data: {
      oauthAccessToken: string
      oauthRefreshToken?: string | null
      oauthExpiresAt?: Date | null
      oauthAccountEmail?: string | null
      oauthProvider?: string | null
    }
  ) {
    return this.update(id, {
      authType: 'oauth',
      oauthProvider: data.oauthProvider || 'openai-codex',
      oauthAccessToken: data.oauthAccessToken,
      oauthRefreshToken: data.oauthRefreshToken || null,
      oauthExpiresAt: data.oauthExpiresAt || null,
      oauthAccountEmail: data.oauthAccountEmail || null,
    })
  }

  static async clearOAuthCredentials(id: string) {
    return this.update(id, {
      authType: 'api_key',
      oauthProvider: null,
      oauthAccessToken: null,
      oauthRefreshToken: null,
      oauthExpiresAt: null,
      oauthAccountEmail: null,
    })
  }

  // Delete provider (cascade deletes models)
  static async delete(id: string) {
    const db = getDatabase()
    await db.delete(providers).where(eq(providers.id, id))
  }

  // Toggle provider enabled status
  static async toggleEnabled(id: string) {
    const db = getDatabase()
    const provider = await this.getById(id)

    if (!provider) return null

    await db
      .update(providers)
      .set({ enabled: !provider.enabled })
      .where(eq(providers.id, id))

    return this.getById(id)
  }
}
