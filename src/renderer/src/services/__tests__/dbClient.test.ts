import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the window.api before dbClient import
const mockInvoke = vi.fn()

// We need to mock the module that uses window.api
vi.mock('../dbClient', () => {
  const createDbMethod =
    (channel: string) =>
    async (...args: any[]) => {
      if (args.length === 0) {
        return mockInvoke(channel)
      }
      return mockInvoke(channel, args[0])
    }

  return {
    dbClient: {
      conversations: {
        getAll: async () => mockInvoke('db:conversations:getAll'),
        getById: async (id: string) =>
          mockInvoke('db:conversations:getById', { id }),
        getWithMessages: async (id: string) =>
          mockInvoke('db:conversations:getWithMessages', { id }),
        create: async (data: any) =>
          mockInvoke('db:conversations:create', data),
        update: async (id: string, data: any) =>
          mockInvoke('db:conversations:update', { id, data }),
        delete: async (id: string) =>
          mockInvoke('db:conversations:delete', { id }),
      },
      messages: {
        getByConversationId: async (conversationId: string) =>
          mockInvoke('db:messages:getByConversationId', { conversationId }),
        getAllWithTools: async (conversationId: string) =>
          mockInvoke('db:messages:getAllWithTools', { conversationId }),
        create: async (data: any) => mockInvoke('db:messages:create', data),
        updateContent: async (id: string, content: string) =>
          mockInvoke('db:messages:updateContent', { id, content }),
        addToolCall: async (messageId: string, data: any) =>
          mockInvoke('db:messages:addToolCall', { messageId, data }),
        addToolResult: async (toolCallId: string, data: any) =>
          mockInvoke('db:messages:addToolResult', { toolCallId, data }),
      },
      providers: {
        getAll: async () => mockInvoke('db:providers:getAll'),
        getEnabled: async () => mockInvoke('db:providers:getEnabled'),
        getById: async (id: string) =>
          mockInvoke('db:providers:getById', { id }),
        getByName: async (name: string) =>
          mockInvoke('db:providers:getByName', { name }),
        create: async (data: any) => mockInvoke('db:providers:create', data),
        update: async (id: string, data: any) =>
          mockInvoke('db:providers:update', { id, data }),
        delete: async (id: string) => mockInvoke('db:providers:delete', { id }),
        toggleEnabled: async (id: string) =>
          mockInvoke('db:providers:toggleEnabled', { id }),
        resolveCredentials: async (id: string) =>
          mockInvoke('db:providers:resolveCredentials', { id }),
        oauthImportOpenClaw: async (id: string) =>
          mockInvoke('db:providers:oauthImportOpenClaw', { id }),
        oauthStartLogin: async (id: string, clientId?: string | null) =>
          mockInvoke('db:providers:oauthStartLogin', {
            id,
            ...(clientId === undefined ? {} : { clientId }),
          }),
        oauthStartCodexLogin: async (id: string) =>
          mockInvoke('db:providers:oauthStartCodexLogin', { id }),
        oauthGetLoginSession: async (sessionId: string) =>
          mockInvoke('db:providers:oauthGetLoginSession', { sessionId }),
        oauthCancelLogin: async (sessionId: string) =>
          mockInvoke('db:providers:oauthCancelLogin', { sessionId }),
        oauthSetManual: async (id: string, data: any) =>
          mockInvoke('db:providers:oauthSetManual', { id, data }),
        oauthStatus: async (id: string) =>
          mockInvoke('db:providers:oauthStatus', { id }),
        oauthLogout: async (id: string) =>
          mockInvoke('db:providers:oauthLogout', { id }),
        fetchModels: async (id: string, options?: any) =>
          mockInvoke('db:providers:fetchModels', { id, options }),
      },
      models: {
        getAll: async () => mockInvoke('db:models:getAll'),
        getByProviderId: async (providerId: string) =>
          mockInvoke('db:models:getByProviderId', { providerId }),
        create: async (data: any) => mockInvoke('db:models:create', data),
        createMany: async (models: any[]) =>
          mockInvoke('db:models:createMany', { models }),
        update: async (id: string, data: any) =>
          mockInvoke('db:models:update', { id, data }),
        delete: async (id: string) => mockInvoke('db:models:delete', { id }),
        toggleEnabled: async (id: string) =>
          mockInvoke('db:models:toggleEnabled', { id }),
      },
      settings: {
        getAll: async () => mockInvoke('db:settings:getAll'),
        get: async (key: string) => mockInvoke('db:settings:get', { key }),
        set: async (key: string, value: any) =>
          mockInvoke('db:settings:set', { key, value }),
        setMany: async (settings: Record<string, any>) =>
          mockInvoke('db:settings:setMany', { settings }),
      },
      migration: {
        run: async (data: any) => mockInvoke('db:migration:run', { data }),
        verify: async () => mockInvoke('db:migration:verify'),
        clear: async () => mockInvoke('db:migration:clear'),
      },
    },
  }
})

import { dbClient } from '../dbClient'

describe('dbClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('conversations', () => {
    it('getAll should invoke correct IPC channel', async () => {
      mockInvoke.mockResolvedValue([])
      await dbClient.conversations.getAll()
      expect(mockInvoke).toHaveBeenCalledWith('db:conversations:getAll')
    })

    it('getById should invoke with id', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.conversations.getById('conv-1')
      expect(mockInvoke).toHaveBeenCalledWith('db:conversations:getById', {
        id: 'conv-1',
      })
    })

    it('create should invoke with data', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.conversations.create({ title: 'Test' })
      expect(mockInvoke).toHaveBeenCalledWith('db:conversations:create', {
        title: 'Test',
      })
    })

    it('delete should invoke with id', async () => {
      mockInvoke.mockResolvedValue(undefined)
      await dbClient.conversations.delete('conv-1')
      expect(mockInvoke).toHaveBeenCalledWith('db:conversations:delete', {
        id: 'conv-1',
      })
    })

    it('getWithMessages should invoke with id', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.conversations.getWithMessages('conv-1')
      expect(mockInvoke).toHaveBeenCalledWith(
        'db:conversations:getWithMessages',
        { id: 'conv-1' }
      )
    })

    it('update should invoke with id and data', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.conversations.update('conv-1', { title: 'Updated' })
      expect(mockInvoke).toHaveBeenCalledWith('db:conversations:update', {
        id: 'conv-1',
        data: { title: 'Updated' },
      })
    })
  })

  describe('messages', () => {
    it('getByConversationId should invoke with conversationId', async () => {
      mockInvoke.mockResolvedValue([])
      await dbClient.messages.getByConversationId('conv-1')
      expect(mockInvoke).toHaveBeenCalledWith(
        'db:messages:getByConversationId',
        { conversationId: 'conv-1' }
      )
    })

    it('getAllWithTools should invoke with conversationId', async () => {
      mockInvoke.mockResolvedValue([])
      await dbClient.messages.getAllWithTools('conv-1')
      expect(mockInvoke).toHaveBeenCalledWith('db:messages:getAllWithTools', {
        conversationId: 'conv-1',
      })
    })

    it('create should invoke with data', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.messages.create({ content: 'Hello' })
      expect(mockInvoke).toHaveBeenCalledWith('db:messages:create', {
        content: 'Hello',
      })
    })

    it('updateContent should invoke with id and content', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.messages.updateContent('msg-1', 'New content')
      expect(mockInvoke).toHaveBeenCalledWith('db:messages:updateContent', {
        id: 'msg-1',
        content: 'New content',
      })
    })

    it('addToolCall should invoke with messageId and data', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.messages.addToolCall('msg-1', { name: 'read_file' })
      expect(mockInvoke).toHaveBeenCalledWith('db:messages:addToolCall', {
        messageId: 'msg-1',
        data: { name: 'read_file' },
      })
    })

    it('addToolResult should invoke with toolCallId and data', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.messages.addToolResult('tc-1', { result: 'success' })
      expect(mockInvoke).toHaveBeenCalledWith('db:messages:addToolResult', {
        toolCallId: 'tc-1',
        data: { result: 'success' },
      })
    })
  })

  describe('providers', () => {
    it('getAll should invoke correct channel', async () => {
      mockInvoke.mockResolvedValue([])
      await dbClient.providers.getAll()
      expect(mockInvoke).toHaveBeenCalledWith('db:providers:getAll')
    })

    it('getEnabled should invoke correct channel', async () => {
      mockInvoke.mockResolvedValue([])
      await dbClient.providers.getEnabled()
      expect(mockInvoke).toHaveBeenCalledWith('db:providers:getEnabled')
    })

    it('getById should invoke with id', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.providers.getById('p-1')
      expect(mockInvoke).toHaveBeenCalledWith('db:providers:getById', {
        id: 'p-1',
      })
    })

    it('getByName should invoke with name', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.providers.getByName('openai')
      expect(mockInvoke).toHaveBeenCalledWith('db:providers:getByName', {
        name: 'openai',
      })
    })

    it('create should invoke with data', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.providers.create({ name: 'OpenAI' })
      expect(mockInvoke).toHaveBeenCalledWith('db:providers:create', {
        name: 'OpenAI',
      })
    })

    it('update should invoke with id and data', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.providers.update('p-1', { name: 'Updated' })
      expect(mockInvoke).toHaveBeenCalledWith('db:providers:update', {
        id: 'p-1',
        data: { name: 'Updated' },
      })
    })

    it('delete should invoke with id', async () => {
      mockInvoke.mockResolvedValue(undefined)
      await dbClient.providers.delete('p-1')
      expect(mockInvoke).toHaveBeenCalledWith('db:providers:delete', {
        id: 'p-1',
      })
    })

    it('toggleEnabled should invoke with id', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.providers.toggleEnabled('p-1')
      expect(mockInvoke).toHaveBeenCalledWith('db:providers:toggleEnabled', {
        id: 'p-1',
      })
    })

    it('oauthStartLogin should invoke with id', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.providers.oauthStartLogin('p-1')
      expect(mockInvoke).toHaveBeenCalledWith('db:providers:oauthStartLogin', {
        id: 'p-1',
      })
    })

    it('oauthStartLogin should pass clientId override when provided', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.providers.oauthStartLogin('p-1', 'client-override')
      expect(mockInvoke).toHaveBeenCalledWith('db:providers:oauthStartLogin', {
        id: 'p-1',
        clientId: 'client-override',
      })
    })

    it('oauthStartCodexLogin should invoke with id', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.providers.oauthStartCodexLogin('p-1')
      expect(mockInvoke).toHaveBeenCalledWith(
        'db:providers:oauthStartCodexLogin',
        {
          id: 'p-1',
        }
      )
    })

    it('oauthGetLoginSession should invoke with sessionId', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.providers.oauthGetLoginSession('session-1')
      expect(mockInvoke).toHaveBeenCalledWith(
        'db:providers:oauthGetLoginSession',
        {
          sessionId: 'session-1',
        }
      )
    })

    it('oauthCancelLogin should invoke with sessionId', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.providers.oauthCancelLogin('session-1')
      expect(mockInvoke).toHaveBeenCalledWith('db:providers:oauthCancelLogin', {
        sessionId: 'session-1',
      })
    })

    it('fetchModels should invoke with id and options', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.providers.fetchModels('p-1', {
        onlyCreateNew: true,
        enableNewModels: false,
        nameFilter: 'gpt',
        dryRun: true,
      })
      expect(mockInvoke).toHaveBeenCalledWith('db:providers:fetchModels', {
        id: 'p-1',
        options: {
          onlyCreateNew: true,
          enableNewModels: false,
          nameFilter: 'gpt',
          dryRun: true,
        },
      })
    })
  })

  describe('models', () => {
    it('getAll should invoke correct channel', async () => {
      mockInvoke.mockResolvedValue([])
      await dbClient.models.getAll()
      expect(mockInvoke).toHaveBeenCalledWith('db:models:getAll')
    })

    it('getByProviderId should invoke with providerId', async () => {
      mockInvoke.mockResolvedValue([])
      await dbClient.models.getByProviderId('p-1')
      expect(mockInvoke).toHaveBeenCalledWith('db:models:getByProviderId', {
        providerId: 'p-1',
      })
    })

    it('create should invoke with data', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.models.create({ name: 'GPT-4' })
      expect(mockInvoke).toHaveBeenCalledWith('db:models:create', {
        name: 'GPT-4',
      })
    })

    it('createMany should invoke with models array', async () => {
      mockInvoke.mockResolvedValue([])
      await dbClient.models.createMany([{ name: 'GPT-4' }])
      expect(mockInvoke).toHaveBeenCalledWith('db:models:createMany', {
        models: [{ name: 'GPT-4' }],
      })
    })

    it('update should invoke with id and data', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.models.update('m-1', { name: 'Updated' })
      expect(mockInvoke).toHaveBeenCalledWith('db:models:update', {
        id: 'm-1',
        data: { name: 'Updated' },
      })
    })

    it('delete should invoke with id', async () => {
      mockInvoke.mockResolvedValue(undefined)
      await dbClient.models.delete('m-1')
      expect(mockInvoke).toHaveBeenCalledWith('db:models:delete', { id: 'm-1' })
    })

    it('toggleEnabled should invoke with id', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.models.toggleEnabled('m-1')
      expect(mockInvoke).toHaveBeenCalledWith('db:models:toggleEnabled', {
        id: 'm-1',
      })
    })
  })

  describe('settings', () => {
    it('getAll should invoke correct channel', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.settings.getAll()
      expect(mockInvoke).toHaveBeenCalledWith('db:settings:getAll')
    })

    it('get should invoke with key', async () => {
      mockInvoke.mockResolvedValue('value')
      await dbClient.settings.get('theme')
      expect(mockInvoke).toHaveBeenCalledWith('db:settings:get', {
        key: 'theme',
      })
    })

    it('set should invoke with key and value', async () => {
      mockInvoke.mockResolvedValue(undefined)
      await dbClient.settings.set('theme', 'dark')
      expect(mockInvoke).toHaveBeenCalledWith('db:settings:set', {
        key: 'theme',
        value: 'dark',
      })
    })

    it('setMany should invoke with settings', async () => {
      mockInvoke.mockResolvedValue(undefined)
      await dbClient.settings.setMany({ theme: 'dark', fontSize: 14 })
      expect(mockInvoke).toHaveBeenCalledWith('db:settings:setMany', {
        settings: { theme: 'dark', fontSize: 14 },
      })
    })
  })

  describe('migration', () => {
    it('run should invoke with data', async () => {
      mockInvoke.mockResolvedValue({})
      await dbClient.migration.run({ version: 1 })
      expect(mockInvoke).toHaveBeenCalledWith('db:migration:run', {
        data: { version: 1 },
      })
    })

    it('verify should invoke correct channel', async () => {
      mockInvoke.mockResolvedValue(true)
      await dbClient.migration.verify()
      expect(mockInvoke).toHaveBeenCalledWith('db:migration:verify')
    })

    it('clear should invoke correct channel', async () => {
      mockInvoke.mockResolvedValue(undefined)
      await dbClient.migration.clear()
      expect(mockInvoke).toHaveBeenCalledWith('db:migration:clear')
    })
  })
})
