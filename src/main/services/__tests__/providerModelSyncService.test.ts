import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderModelSyncService } from '../providerModelSyncService'

const providerServiceMock = vi.hoisted(() => ({
  getById: vi.fn(),
}))

const modelServiceMock = vi.hoisted(() => ({
  getByProviderId: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}))

const openAIOAuthServiceMock = vi.hoisted(() => ({
  resolveProviderCredentials: vi.fn(),
}))

vi.mock('../../db/services', () => ({
  ProviderService: providerServiceMock,
  ModelService: modelServiceMock,
}))

vi.mock('../openAIOAuthService', () => ({
  OpenAIOAuthService: openAIOAuthServiceMock,
}))

describe('ProviderModelSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ProviderModelSyncService.clearTestOverrides()
  })

  it('should sync OpenAI-compatible models and create new records', async () => {
    providerServiceMock.getById.mockResolvedValue({
      id: 'provider-openai',
      type: 'openai',
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      apiFormat: 'chat-completions',
    })
    openAIOAuthServiceMock.resolveProviderCredentials.mockResolvedValue({
      apiKey: 'token-1',
    })
    modelServiceMock.getByProviderId.mockResolvedValue([])

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1' }],
      }),
    }))

    ProviderModelSyncService.setTestOverrides({
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const result = await ProviderModelSyncService.syncProviderModels('provider-openai')

    expect(result.providerId).toBe('provider-openai')
    expect(result.discovered).toBe(2)
    expect(result.created).toBe(2)
    expect(modelServiceMock.create).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        method: 'GET',
      })
    )
  })

  it('should update existing discovered model names without recreating them', async () => {
    providerServiceMock.getById.mockResolvedValue({
      id: 'provider-openai',
      type: 'openai',
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      apiFormat: 'responses',
    })
    openAIOAuthServiceMock.resolveProviderCredentials.mockResolvedValue({
      apiKey: 'token-2',
    })
    modelServiceMock.getByProviderId.mockResolvedValue([
      {
        id: 'model-existing',
        providerId: 'provider-openai',
        modelId: 'gpt-4o',
        name: 'Old Name',
        contextLength: null,
        isCustom: false,
        enabled: true,
      },
    ])

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        data: [{ id: 'gpt-4o', name: 'GPT-4o Latest' }],
      }),
    }))

    ProviderModelSyncService.setTestOverrides({
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const result = await ProviderModelSyncService.syncProviderModels('provider-openai')

    expect(result.discovered).toBe(1)
    expect(result.created).toBe(0)
    expect(result.updated).toBe(1)
    expect(modelServiceMock.update).toHaveBeenCalledWith('model-existing', {
      name: 'GPT-4o Latest',
    })
    expect(modelServiceMock.create).not.toHaveBeenCalled()
  })

  it('should sync Anthropic models via provider adapter', async () => {
    providerServiceMock.getById.mockResolvedValue({
      id: 'provider-claude',
      type: 'claude',
      name: 'Claude',
      baseURL: 'https://api.anthropic.com',
      apiFormat: 'anthropic-messages',
    })
    openAIOAuthServiceMock.resolveProviderCredentials.mockResolvedValue({
      apiKey: 'anthropic-key',
    })
    modelServiceMock.getByProviderId.mockResolvedValue([])

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        data: [
          { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5' },
        ],
      }),
    }))

    ProviderModelSyncService.setTestOverrides({
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const result = await ProviderModelSyncService.syncProviderModels('provider-claude')

    expect(result.discovered).toBe(1)
    expect(result.created).toBe(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'anthropic-key',
        }),
      })
    )
  })

  it('should sync Gemini models via provider adapter', async () => {
    providerServiceMock.getById.mockResolvedValue({
      id: 'provider-gemini',
      type: 'gemini',
      name: 'Gemini',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      apiFormat: 'chat-completions',
    })
    openAIOAuthServiceMock.resolveProviderCredentials.mockResolvedValue({
      apiKey: 'gemini-key',
    })
    modelServiceMock.getByProviderId.mockResolvedValue([])

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        models: [{ name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' }],
      }),
    }))

    ProviderModelSyncService.setTestOverrides({
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const result = await ProviderModelSyncService.syncProviderModels('provider-gemini')

    expect(result.discovered).toBe(1)
    expect(result.created).toBe(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key',
      expect.objectContaining({
        method: 'GET',
      })
    )
  })

  it('should apply sync strategy options (only create, disable new, name filter)', async () => {
    providerServiceMock.getById.mockResolvedValue({
      id: 'provider-openai',
      type: 'openai',
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      apiFormat: 'chat-completions',
    })
    openAIOAuthServiceMock.resolveProviderCredentials.mockResolvedValue({
      apiKey: 'token-3',
    })
    modelServiceMock.getByProviderId.mockResolvedValue([
      {
        id: 'model-existing',
        providerId: 'provider-openai',
        modelId: 'gpt-4o',
        name: 'Old Name',
        contextLength: null,
        isCustom: false,
        enabled: true,
      },
    ])

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        data: [{ id: 'gpt-4o', name: 'New Name' }, { id: 'gpt-4.1-mini' }],
      }),
    }))

    ProviderModelSyncService.setTestOverrides({
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const result = await ProviderModelSyncService.syncProviderModels(
      'provider-openai',
      {
        onlyCreateNew: true,
        enableNewModels: false,
        nameFilter: 'mini',
      }
    )

    expect(result.discovered).toBe(1)
    expect(result.filteredOut).toBe(1)
    expect(result.created).toBe(1)
    expect(modelServiceMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'gpt-4.1-mini',
        enabled: false,
      })
    )
    expect(modelServiceMock.update).not.toHaveBeenCalled()
  })

  it('should return preview result without mutating models when dryRun is enabled', async () => {
    providerServiceMock.getById.mockResolvedValue({
      id: 'provider-openai',
      type: 'openai',
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      apiFormat: 'chat-completions',
    })
    openAIOAuthServiceMock.resolveProviderCredentials.mockResolvedValue({
      apiKey: 'token-4',
    })
    modelServiceMock.getByProviderId.mockResolvedValue([
      {
        id: 'model-existing',
        providerId: 'provider-openai',
        modelId: 'gpt-4o',
        name: 'Old Name',
        contextLength: null,
        isCustom: false,
        enabled: true,
      },
    ])

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        data: [
          { id: 'gpt-4o', name: 'GPT-4o Latest' },
          { id: 'gpt-4.1-mini' },
        ],
      }),
    }))

    ProviderModelSyncService.setTestOverrides({
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const result = await ProviderModelSyncService.syncProviderModels(
      'provider-openai',
      {
        dryRun: true,
      }
    )

    expect(result.dryRun).toBe(true)
    expect(result.created).toBe(1)
    expect(result.updated).toBe(1)
    expect(result.toCreate).toEqual(['gpt-4.1-mini'])
    expect(result.toUpdate).toEqual(['gpt-4o'])
    expect(modelServiceMock.create).not.toHaveBeenCalled()
    expect(modelServiceMock.update).not.toHaveBeenCalled()
  })
})
