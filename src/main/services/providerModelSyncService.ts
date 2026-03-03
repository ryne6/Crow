import { ModelService, ProviderService } from '../db/services'
import { OpenAIOAuthService } from './openAIOAuthService'

interface ModelDescriptor {
  modelId: string
  name: string
}

interface ProviderModelSyncOptions {
  onlyCreateNew?: boolean
  enableNewModels?: boolean
  nameFilter?: string | null
  dryRun?: boolean
}

interface EffectiveProviderModelSyncOptions {
  onlyCreateNew: boolean
  enableNewModels: boolean
  nameFilter: string | null
  dryRun: boolean
}

interface ProviderModelSyncResult {
  providerId: string
  providerType: string
  dryRun: boolean
  discovered: number
  filteredOut: number
  created: number
  updated: number
  unchanged: number
  toCreate: string[]
  toUpdate: string[]
  models: string[]
}

interface ProviderRecordLike {
  id: string
  type: string
  name: string
  baseURL?: string | null
  apiFormat?: string | null
  modelSyncOnlyCreate?: boolean | null
  modelSyncEnableNewModels?: boolean | null
  modelSyncNameFilter?: string | null
}

interface DiscoveryContext {
  provider: ProviderRecordLike
  apiKey: string
}

interface ModelDiscoveryAdapter {
  readonly name: string
  canHandle(provider: ProviderRecordLike): boolean
  discover(ctx: DiscoveryContext, fetchImpl: typeof fetch): Promise<ModelDescriptor[]>
}

interface ProviderModelSyncServiceTestOverrides {
  fetchImpl?: typeof fetch
}

function safeString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function joinUrl(baseUrl: string, pathOrQuery: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL(pathOrQuery.replace(/^\/+/, ''), normalizedBase).toString()
}

async function readResponseSnippet(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.slice(0, 200)
  } catch {
    return ''
  }
}

function uniqueByModelId(models: ModelDescriptor[]): ModelDescriptor[] {
  const seen = new Set<string>()
  const deduped: ModelDescriptor[] = []
  for (const model of models) {
    if (seen.has(model.modelId)) continue
    seen.add(model.modelId)
    deduped.push(model)
  }
  return deduped
}

function applyNameFilter(
  models: ModelDescriptor[],
  nameFilter: string | null
): { filtered: ModelDescriptor[]; filteredOut: number } {
  const normalized = safeString(nameFilter)
  if (!normalized) {
    return { filtered: models, filteredOut: 0 }
  }

  const keywords = normalized
    .split(',')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean)

  if (keywords.length === 0) {
    return { filtered: models, filteredOut: 0 }
  }

  const filtered = models.filter(model => {
    const haystacks = [model.modelId.toLowerCase(), model.name.toLowerCase()]
    return keywords.some(keyword => haystacks.some(text => text.includes(keyword)))
  })

  return {
    filtered,
    filteredOut: models.length - filtered.length,
  }
}

class OpenAICompatibleModelAdapter implements ModelDiscoveryAdapter {
  readonly name = 'openai-compatible'

  canHandle(provider: ProviderRecordLike): boolean {
    if (provider.type === 'gemini' || provider.type === 'claude') return false
    if (provider.apiFormat === 'anthropic-messages') return false
    if (
      provider.type === 'openai' ||
      provider.type === 'deepseek' ||
      provider.type === 'moonshot' ||
      provider.type === 'openrouter'
    ) {
      return true
    }
    return provider.apiFormat === 'chat-completions' || provider.apiFormat === 'responses'
  }

  async discover(ctx: DiscoveryContext, fetchImpl: typeof fetch): Promise<ModelDescriptor[]> {
    const baseUrl = safeString(ctx.provider.baseURL) || 'https://api.openai.com/v1'
    const url = joinUrl(baseUrl, 'models')
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      const snippet = await readResponseSnippet(response)
      throw new Error(
        `Failed to fetch models from ${ctx.provider.name} (${response.status}) ${snippet}`
      )
    }

    const payload = (await response.json()) as Record<string, unknown>
    const rawData = Array.isArray(payload.data) ? payload.data : []
    const models: ModelDescriptor[] = []

    for (const item of rawData) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const modelId = safeString(record.id)
      if (!modelId) continue
      models.push({
        modelId,
        name: safeString(record.name) || modelId,
      })
    }

    return uniqueByModelId(models)
  }
}

class AnthropicModelAdapter implements ModelDiscoveryAdapter {
  readonly name = 'anthropic'

  canHandle(provider: ProviderRecordLike): boolean {
    return provider.type === 'claude' || provider.apiFormat === 'anthropic-messages'
  }

  async discover(ctx: DiscoveryContext, fetchImpl: typeof fetch): Promise<ModelDescriptor[]> {
    const baseUrl = safeString(ctx.provider.baseURL) || 'https://api.anthropic.com'
    const url = joinUrl(baseUrl, 'v1/models')
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'x-api-key': ctx.apiKey,
        'anthropic-version': '2023-06-01',
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      const snippet = await readResponseSnippet(response)
      throw new Error(
        `Failed to fetch models from ${ctx.provider.name} (${response.status}) ${snippet}`
      )
    }

    const payload = (await response.json()) as Record<string, unknown>
    const rawData = Array.isArray(payload.data) ? payload.data : []
    const models: ModelDescriptor[] = []

    for (const item of rawData) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const modelId = safeString(record.id)
      if (!modelId) continue
      models.push({
        modelId,
        name: safeString(record.display_name) || safeString(record.name) || modelId,
      })
    }

    return uniqueByModelId(models)
  }
}

class GeminiModelAdapter implements ModelDiscoveryAdapter {
  readonly name = 'gemini'

  canHandle(provider: ProviderRecordLike): boolean {
    return provider.type === 'gemini'
  }

  async discover(ctx: DiscoveryContext, fetchImpl: typeof fetch): Promise<ModelDescriptor[]> {
    const baseUrl =
      safeString(ctx.provider.baseURL) ||
      'https://generativelanguage.googleapis.com/v1beta'
    const url = joinUrl(baseUrl, `models?key=${encodeURIComponent(ctx.apiKey)}`)
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      const snippet = await readResponseSnippet(response)
      throw new Error(
        `Failed to fetch models from ${ctx.provider.name} (${response.status}) ${snippet}`
      )
    }

    const payload = (await response.json()) as Record<string, unknown>
    const rawModels = Array.isArray(payload.models) ? payload.models : []
    const models: ModelDescriptor[] = []

    for (const item of rawModels) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const rawName = safeString(record.name)
      if (!rawName) continue
      const modelId = rawName.replace(/^models\//, '')
      if (!modelId) continue
      models.push({
        modelId,
        name: safeString(record.displayName) || modelId,
      })
    }

    return uniqueByModelId(models)
  }
}

export class ProviderModelSyncService {
  private static fetchImpl: typeof fetch = fetch

  private static readonly adapters: ModelDiscoveryAdapter[] = [
    new GeminiModelAdapter(),
    new AnthropicModelAdapter(),
    new OpenAICompatibleModelAdapter(),
  ]

  static setTestOverrides(overrides: ProviderModelSyncServiceTestOverrides = {}) {
    if (overrides.fetchImpl) {
      this.fetchImpl = overrides.fetchImpl
    }
  }

  static clearTestOverrides() {
    this.fetchImpl = fetch
  }

  private static pickAdapter(provider: ProviderRecordLike): ModelDiscoveryAdapter {
    const adapter = this.adapters.find(candidate => candidate.canHandle(provider))
    if (!adapter) {
      throw new Error(`Model sync is not supported for provider type: ${provider.type}`)
    }
    return adapter
  }

  private static resolveEffectiveOptions(
    provider: ProviderRecordLike,
    options?: ProviderModelSyncOptions
  ): EffectiveProviderModelSyncOptions {
    return {
      onlyCreateNew: options?.onlyCreateNew ?? provider.modelSyncOnlyCreate ?? false,
      enableNewModels:
        options?.enableNewModels ?? provider.modelSyncEnableNewModels ?? true,
      nameFilter: options?.nameFilter ?? provider.modelSyncNameFilter ?? null,
      dryRun: options?.dryRun ?? false,
    }
  }

  static async syncProviderModels(
    providerId: string,
    options?: ProviderModelSyncOptions
  ): Promise<ProviderModelSyncResult> {
    const provider = await ProviderService.getById(providerId)
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`)
    }

    const resolvedCredentials =
      await OpenAIOAuthService.resolveProviderCredentials(providerId)
    const adapter = this.pickAdapter(provider)
    const discoveredFromProvider = await adapter.discover(
      { provider, apiKey: resolvedCredentials.apiKey },
      this.fetchImpl
    )
    const effectiveOptions = this.resolveEffectiveOptions(provider, options)
    const { filtered: discoveredModels, filteredOut } = applyNameFilter(
      discoveredFromProvider,
      effectiveOptions.nameFilter
    )

    const existingModels = await ModelService.getByProviderId(providerId)
    const existingByModelId = new Map(
      existingModels.map(model => [model.modelId, model])
    )

    const toCreate: ModelDescriptor[] = []
    const toUpdate: Array<{ id: string; modelId: string; name: string }> = []
    let unchanged = 0

    for (const discovered of discoveredModels) {
      const existing = existingByModelId.get(discovered.modelId)
      if (!existing) {
        toCreate.push(discovered)
        continue
      }

      if (existing.isCustom) {
        unchanged++
        continue
      }

      if (!effectiveOptions.onlyCreateNew && existing.name !== discovered.name) {
        toUpdate.push({
          id: existing.id,
          modelId: discovered.modelId,
          name: discovered.name,
        })
      } else {
        unchanged++
      }
    }

    if (!effectiveOptions.dryRun) {
      for (const createCandidate of toCreate) {
        await ModelService.create({
          providerId,
          modelId: createCandidate.modelId,
          name: createCandidate.name,
          contextLength: null,
          isCustom: false,
          enabled: effectiveOptions.enableNewModels,
        })
      }

      for (const updateCandidate of toUpdate) {
        await ModelService.update(updateCandidate.id, {
          name: updateCandidate.name,
        })
      }
    }

    const created = toCreate.length
    const updated = toUpdate.length

    return {
      providerId,
      providerType: provider.type,
      dryRun: effectiveOptions.dryRun,
      discovered: discoveredModels.length,
      filteredOut,
      created,
      updated,
      unchanged,
      toCreate: toCreate.map(model => model.modelId),
      toUpdate: toUpdate.map(model => model.modelId),
      models: discoveredModels.map(model => model.modelId),
    }
  }
}

export type { ProviderModelSyncOptions, ProviderModelSyncResult }
