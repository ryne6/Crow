import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createTestDatabase,
  clearDatabase,
} from '../../../../../tests/setup/test-db'
import type { Database } from 'better-sqlite3'
import * as schema from '../../schema'

/**
 * ProviderService 测试
 *
 * 测试目标：
 * - 加密/解密 API key
 * - CRUD 操作
 * - 级联删除（删除 provider 时删除关联的 models）
 * - 边界情况处理
 */

// Use vi.hoisted to ensure mock is set up before imports
const { getTestDb, setTestDb } = vi.hoisted(() => {
  let testDb: any = null
  return {
    getTestDb: () => testDb,
    setTestDb: (db: any) => {
      testDb = db
    },
  }
})

// Mock the database module with hoisted functions
vi.mock('../../index', async () => {
  const actualSchema =
    await vi.importActual<typeof import('../../schema')>('../../schema')
  return {
    getDatabase: () => {
      const db = getTestDb()
      if (!db) {
        throw new Error('Test database not initialized')
      }
      return db
    },
    schema: actualSchema,
  }
})

// Mock generateId
vi.mock('../../utils/idGenerator', () => ({
  generateId: vi.fn(() => `test-id-${Date.now()}`),
}))

// Import ProviderService after mocking
import { ProviderService } from '../providerService'

describe('ProviderService', () => {
  let testDb: { db: any; sqlite: Database; cleanup: () => void }

  beforeEach(async () => {
    // 创建测试数据库
    testDb = createTestDatabase()

    // 设置测试数据库到 hoisted mock
    setTestDb(testDb.db)
  })

  afterEach(() => {
    // 清理数据库
    if (testDb?.sqlite) {
      clearDatabase(testDb.sqlite)
      testDb.cleanup()
    }
  })

  describe('加密/解密测试', () => {
    it('should encrypt API key when creating provider', async () => {
      const providerData = {
        name: 'Test Provider',
        type: 'openai' as const,
        apiKey: 'test-api-key-12345',
      }

      const created = await ProviderService.create(providerData)

      // The returned provider should have unencrypted API key
      expect(created.apiKey).toBe('test-api-key-12345')

      // But in the database, it should be encrypted
      const dbProvider = (await testDb.sqlite
        .prepare('SELECT * FROM providers WHERE id = ?')
        .get(created.id)) as any

      expect(dbProvider.api_key).not.toBe('test-api-key-12345')
      expect(dbProvider.api_key).toContain(':') // Encrypted format: iv:encrypted
    })

    it('should decrypt API key when retrieving provider', async () => {
      const providerData = {
        name: 'Test Provider',
        type: 'openai' as const,
        apiKey: 'test-api-key-12345',
      }

      const created = await ProviderService.create(providerData)
      const retrieved = await ProviderService.getById(created.id)

      expect(retrieved).not.toBeNull()
      expect(retrieved!.apiKey).toBe('test-api-key-12345')
    })

    it('should encrypt API key when updating provider', async () => {
      const providerData = {
        name: 'Test Provider',
        type: 'openai' as const,
        apiKey: 'original-key',
      }

      const created = await ProviderService.create(providerData)
      await ProviderService.update(created.id, { apiKey: 'updated-key' })

      const updated = await ProviderService.getById(created.id)
      expect(updated!.apiKey).toBe('updated-key')
    })

    it('should encrypt and decrypt OAuth tokens', async () => {
      const created = await ProviderService.create({
        name: 'OpenAI OAuth',
        type: 'openai' as const,
        apiKey: 'placeholder-key',
        authType: 'oauth',
        oauthProvider: 'openai-codex',
        oauthAccessToken: 'oauth-access-token',
        oauthRefreshToken: 'oauth-refresh-token',
      })

      const dbProvider = (await testDb.sqlite
        .prepare('SELECT * FROM providers WHERE id = ?')
        .get(created.id)) as any

      expect(dbProvider.oauth_access_token).toContain(':')
      expect(dbProvider.oauth_refresh_token).toContain(':')
      expect(dbProvider.oauth_access_token).not.toBe('oauth-access-token')
      expect(dbProvider.oauth_refresh_token).not.toBe('oauth-refresh-token')

      const retrieved = await ProviderService.getById(created.id)
      expect(retrieved?.authType).toBe('oauth')
      expect(retrieved?.oauthAccessToken).toBe('oauth-access-token')
      expect(retrieved?.oauthRefreshToken).toBe('oauth-refresh-token')
    })

    it('should keep existing API key when OAuth credentials are updated', async () => {
      const created = await ProviderService.create({
        name: 'OpenAI Hybrid',
        type: 'openai' as const,
        apiKey: 'sk-original-key',
      })

      await ProviderService.setOAuthCredentials(created.id, {
        oauthAccessToken: 'oauth-access-token',
        oauthRefreshToken: 'oauth-refresh-token',
        oauthProvider: 'openai-codex',
      })

      const updated = await ProviderService.getById(created.id)
      expect(updated?.authType).toBe('oauth')
      expect(updated?.apiKey).toBe('sk-original-key')
      expect(updated?.oauthAccessToken).toBe('oauth-access-token')
    })
  })

  describe('CRUD 操作测试', () => {
    it('should create a new provider', async () => {
      const providerData = {
        name: 'OpenAI',
        type: 'openai' as const,
        apiKey: 'sk-test-key',
        baseURL: 'https://api.openai.com',
      }

      const created = await ProviderService.create(providerData)

      expect(created).toBeDefined()
      expect(created.id).toBeDefined()
      expect(created.name).toBe('OpenAI')
      expect(created.type).toBe('openai')
      expect(created.apiKey).toBe('sk-test-key')
      expect(created.baseURL).toBe('https://api.openai.com')
      expect(created.enabled).toBe(true)
    })

    it('should get all providers', async () => {
      await ProviderService.create({
        name: 'Provider 1',
        type: 'openai' as const,
        apiKey: 'key1',
      })

      await ProviderService.create({
        name: 'Provider 2',
        type: 'claude' as const,
        apiKey: 'key2',
      })

      const allProviders = await ProviderService.getAll()

      expect(allProviders).toHaveLength(2)
      expect(allProviders[0].apiKey).toBe('key1')
      expect(allProviders[1].apiKey).toBe('key2')
    })

    it('should get provider by ID', async () => {
      const created = await ProviderService.create({
        name: 'Test Provider',
        type: 'openai' as const,
        apiKey: 'test-key',
      })

      const retrieved = await ProviderService.getById(created.id)

      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(created.id)
      expect(retrieved!.name).toBe('Test Provider')
    })

    it('should get provider by name', async () => {
      await ProviderService.create({
        name: 'Unique Provider',
        type: 'openai' as const,
        apiKey: 'test-key',
      })

      const retrieved = await ProviderService.getByName('Unique Provider')

      expect(retrieved).not.toBeNull()
      expect(retrieved!.name).toBe('Unique Provider')
    })

    it('should update provider', async () => {
      const created = await ProviderService.create({
        name: 'Original Name',
        type: 'openai' as const,
        apiKey: 'original-key',
      })

      await ProviderService.update(created.id, {
        name: 'Updated Name',
        baseURL: 'https://new-url.com',
      })

      const updated = await ProviderService.getById(created.id)

      expect(updated!.name).toBe('Updated Name')
      expect(updated!.baseURL).toBe('https://new-url.com')
      expect(updated!.apiKey).toBe('original-key')
    })

    it('should delete provider', async () => {
      const created = await ProviderService.create({
        name: 'To Delete',
        type: 'openai' as const,
        apiKey: 'test-key',
      })

      await ProviderService.delete(created.id)

      const retrieved = await ProviderService.getById(created.id)
      expect(retrieved).toBeNull()
    })
  })

  describe('过滤测试', () => {
    it('should get only enabled providers', async () => {
      await ProviderService.create({
        name: 'Enabled Provider',
        type: 'openai' as const,
        apiKey: 'key1',
        enabled: true,
      })

      await ProviderService.create({
        name: 'Disabled Provider',
        type: 'claude' as const,
        apiKey: 'key2',
        enabled: false,
      })

      const enabledProviders = await ProviderService.getEnabled()

      expect(enabledProviders).toHaveLength(1)
      expect(enabledProviders[0].name).toBe('Enabled Provider')
      expect(enabledProviders[0].enabled).toBe(true)
    })

    it('should return empty array when no enabled providers', async () => {
      await ProviderService.create({
        name: 'Disabled Provider',
        type: 'openai' as const,
        apiKey: 'key1',
        enabled: false,
      })

      const enabledProviders = await ProviderService.getEnabled()

      expect(enabledProviders).toHaveLength(0)
    })
  })

  describe('边界情况测试', () => {
    it('should return null when getting non-existent provider by ID', async () => {
      const retrieved = await ProviderService.getById('non-existent-id')

      expect(retrieved).toBeNull()
    })

    it('should return null when getting non-existent provider by name', async () => {
      const retrieved = await ProviderService.getByName('Non-existent Provider')

      expect(retrieved).toBeNull()
    })

    it('should create provider with default values', async () => {
      const created = await ProviderService.create({
        name: 'Minimal Provider',
        type: 'openai' as const,
        apiKey: 'test-key',
      })

      expect(created.enabled).toBe(true)
      expect(created.apiFormat).toBe('chat-completions')
      expect(created.baseURL).toBeNull()
    })

    it('should handle empty provider list', async () => {
      const allProviders = await ProviderService.getAll()

      expect(allProviders).toHaveLength(0)
    })
  })

  describe('toggleEnabled 测试', () => {
    it('should toggle provider enabled status from true to false', async () => {
      const created = await ProviderService.create({
        name: 'Test Provider',
        type: 'openai' as const,
        apiKey: 'test-key',
        enabled: true,
      })

      const toggled = await ProviderService.toggleEnabled(created.id)

      expect(toggled).not.toBeNull()
      expect(toggled!.enabled).toBe(false)
    })

    it('should toggle provider enabled status from false to true', async () => {
      const created = await ProviderService.create({
        name: 'Test Provider',
        type: 'openai' as const,
        apiKey: 'test-key',
        enabled: false,
      })

      const toggled = await ProviderService.toggleEnabled(created.id)

      expect(toggled).not.toBeNull()
      expect(toggled!.enabled).toBe(true)
    })

    it('should return null when toggling non-existent provider', async () => {
      const result = await ProviderService.toggleEnabled('non-existent-id')

      expect(result).toBeNull()
    })
  })

  describe('级联删除测试', () => {
    it('should cascade delete models when deleting provider', async () => {
      // Create a provider
      const provider = await ProviderService.create({
        name: 'Test Provider',
        type: 'openai' as const,
        apiKey: 'test-key',
      })

      // Create models associated with this provider using raw SQL
      testDb.sqlite.exec(`
        INSERT INTO models (id, provider_id, model_id, name, enabled)
        VALUES
          ('model-1', '${provider.id}', 'gpt-4', 'GPT-4', 1),
          ('model-2', '${provider.id}', 'gpt-3.5', 'GPT-3.5', 1)
      `)

      // Verify models exist
      const modelsBefore = testDb.sqlite
        .prepare('SELECT * FROM models WHERE provider_id = ?')
        .all(provider.id)
      expect(modelsBefore).toHaveLength(2)

      // Delete the provider
      await ProviderService.delete(provider.id)

      // Verify provider is deleted
      const deletedProvider = await ProviderService.getById(provider.id)
      expect(deletedProvider).toBeNull()

      // Verify models are also deleted (cascade)
      const modelsAfter = testDb.sqlite
        .prepare('SELECT * FROM models WHERE provider_id = ?')
        .all(provider.id)
      expect(modelsAfter).toHaveLength(0)
    })
  })
})
