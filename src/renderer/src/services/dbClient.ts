// Database client for IPC communication
import type { MCPServerState, Skill, SkillsDirectory } from '~shared/types/ipc'

export interface ProviderRecord {
  id: string
  name: string
  type: string
  apiKey: string
  baseURL: string | null
  apiFormat?: string | null
  authType?: 'api_key' | 'oauth'
  oauthAutoFetchModels?: boolean
  modelSyncOnlyCreate?: boolean
  modelSyncEnableNewModels?: boolean
  modelSyncNameFilter?: string | null
  oauthProvider?: string | null
  oauthAccessToken?: string | null
  oauthRefreshToken?: string | null
  oauthExpiresAt?: string | Date | null
  oauthAccountEmail?: string | null
  enabled: boolean
}

export interface ProviderResolvedCredentials {
  apiKey: string
  authType: 'api_key' | 'oauth'
  oauthProvider: string | null
  accountEmail: string | null
  expiresAt: string | null
}

export interface ProviderOAuthStatus {
  authType: 'api_key' | 'oauth'
  connected: boolean
  hasAccessToken: boolean
  hasRefreshToken: boolean
  oauthProvider: string | null
  accountEmail: string | null
  expiresAt: string | null
  isExpired: boolean
}

export interface ProviderModelSyncResult {
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

export interface ProviderModelSyncOptions {
  onlyCreateNew?: boolean
  enableNewModels?: boolean
  nameFilter?: string | null
  dryRun?: boolean
}

export interface OpenClawOAuthImportResult {
  imported: boolean
  sourcePath: string
  profileId: string | null
  oauthProvider: string
  accountEmail: string | null
  expiresAt: string | null
}

export type ProviderOAuthLoginSessionState =
  | 'pending'
  | 'opened'
  | 'code_received'
  | 'exchanging'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timeout'

export interface ProviderOAuthLoginStartResult {
  sessionId: string
  authUrl: string
  redirectUri: string
  expiresAt: string
}

export interface ProviderOAuthLoginSession {
  sessionId: string
  providerId: string
  status: ProviderOAuthLoginSessionState
  createdAt: string
  expiresAt: string
  authUrl: string
  redirectUri: string
  state: string
  codeVerifier: string
  codeChallenge: string
  authorizationCode: string | null
  error: string | null
}

export interface ProviderOAuthLoginPollResult {
  session: ProviderOAuthLoginSession | null
  oauthStatus: ProviderOAuthStatus | null
}

export interface ModelRecord {
  id: string
  providerId: string
  modelId: string
  name: string
  contextLength?: number | null
  isCustom: boolean
  enabled: boolean
}

interface MigrationStats {
  conversations: number
  providers: number
  models: number
  settings: number
  messages: number
}

interface MigrationResult {
  success: boolean
  error?: unknown
}

interface MCPServerRecord {
  id: string
  name: string
  command: string
  args?: string[] | null
  env?: Record<string, string> | null
  enabled: boolean
}

export const dbClient = {
  // Conversations
  conversations: {
    getAll: async () => {
      return await window.api.ipc.invoke('db:conversations:getAll')
    },
    getById: async (id: string) => {
      return await window.api.ipc.invoke('db:conversations:getById', { id })
    },
    getWithMessages: async (id: string) => {
      return await window.api.ipc.invoke('db:conversations:getWithMessages', {
        id,
      })
    },
    create: async (data: Record<string, unknown>) => {
      return await window.api.ipc.invoke('db:conversations:create', data)
    },
    update: async (id: string, data: Record<string, unknown>) => {
      return await window.api.ipc.invoke('db:conversations:update', {
        id,
        data,
      })
    },
    delete: async (id: string) => {
      return await window.api.ipc.invoke('db:conversations:delete', { id })
    },
  },

  // Messages
  messages: {
    getByConversationId: async (conversationId: string) => {
      return await window.api.ipc.invoke('db:messages:getByConversationId', {
        conversationId,
      })
    },
    getAllWithTools: async (conversationId: string) => {
      return await window.api.ipc.invoke('db:messages:getAllWithTools', {
        conversationId,
      })
    },
    create: async (data: Record<string, unknown>) => {
      return await window.api.ipc.invoke('db:messages:create', data)
    },
    updateContent: async (id: string, content: string) => {
      return await window.api.ipc.invoke('db:messages:updateContent', {
        id,
        content,
      })
    },
    addToolCall: async (messageId: string, data: Record<string, unknown>) => {
      return await window.api.ipc.invoke('db:messages:addToolCall', {
        messageId,
        data,
      })
    },
    addToolResult: async (toolCallId: string, data: Record<string, unknown>) => {
      return await window.api.ipc.invoke('db:messages:addToolResult', {
        toolCallId,
        data,
      })
    },
  },

  // Providers
  providers: {
    getAll: async (): Promise<ProviderRecord[]> => {
      return await window.api.ipc.invoke<ProviderRecord[]>('db:providers:getAll')
    },
    getEnabled: async (): Promise<ProviderRecord[]> => {
      return await window.api.ipc.invoke<ProviderRecord[]>('db:providers:getEnabled')
    },
    getById: async (id: string): Promise<ProviderRecord | null> => {
      return await window.api.ipc.invoke<ProviderRecord | null>(
        'db:providers:getById',
        { id }
      )
    },
    getByName: async (name: string): Promise<ProviderRecord | null> => {
      return await window.api.ipc.invoke<ProviderRecord | null>(
        'db:providers:getByName',
        { name }
      )
    },
    create: async (data: Record<string, unknown>): Promise<ProviderRecord> => {
      return await window.api.ipc.invoke<ProviderRecord>('db:providers:create', data)
    },
    update: async (
      id: string,
      data: Record<string, unknown>
    ): Promise<ProviderRecord | null> => {
      return await window.api.ipc.invoke<ProviderRecord | null>(
        'db:providers:update',
        {
          id,
          data,
        }
      )
    },
    delete: async (id: string): Promise<void> => {
      return await window.api.ipc.invoke<void>('db:providers:delete', { id })
    },
    toggleEnabled: async (id: string): Promise<ProviderRecord | null> => {
      return await window.api.ipc.invoke<ProviderRecord | null>(
        'db:providers:toggleEnabled',
        { id }
      )
    },
    resolveCredentials: async (
      id: string
    ): Promise<ProviderResolvedCredentials> => {
      return await window.api.ipc.invoke<ProviderResolvedCredentials>(
        'db:providers:resolveCredentials',
        { id }
      )
    },
    oauthImportOpenClaw: async (
      id: string
    ): Promise<OpenClawOAuthImportResult> => {
      return await window.api.ipc.invoke<OpenClawOAuthImportResult>(
        'db:providers:oauthImportOpenClaw',
        { id }
      )
    },
    oauthStartLogin: async (
      id: string
    ): Promise<ProviderOAuthLoginStartResult> => {
      return await window.api.ipc.invoke<ProviderOAuthLoginStartResult>(
        'db:providers:oauthStartLogin',
        { id }
      )
    },
    oauthGetLoginSession: async (
      sessionId: string
    ): Promise<ProviderOAuthLoginPollResult> => {
      return await window.api.ipc.invoke<ProviderOAuthLoginPollResult>(
        'db:providers:oauthGetLoginSession',
        { sessionId }
      )
    },
    oauthCancelLogin: async (
      sessionId: string
    ): Promise<ProviderOAuthLoginSession | null> => {
      return await window.api.ipc.invoke<ProviderOAuthLoginSession | null>(
        'db:providers:oauthCancelLogin',
        { sessionId }
      )
    },
    oauthSetManual: async (
      id: string,
      data: {
        accessToken: string
        refreshToken?: string | null
        expiresAt?: string | null
        accountEmail?: string | null
        oauthProvider?: string | null
      }
    ): Promise<ProviderOAuthStatus> => {
      return await window.api.ipc.invoke<ProviderOAuthStatus>(
        'db:providers:oauthSetManual',
        { id, data }
      )
    },
    oauthStatus: async (id: string): Promise<ProviderOAuthStatus> => {
      return await window.api.ipc.invoke<ProviderOAuthStatus>(
        'db:providers:oauthStatus',
        { id }
      )
    },
    oauthLogout: async (id: string): Promise<ProviderOAuthStatus> => {
      return await window.api.ipc.invoke<ProviderOAuthStatus>(
        'db:providers:oauthLogout',
        { id }
      )
    },
    fetchModels: async (
      id: string,
      options?: ProviderModelSyncOptions
    ): Promise<ProviderModelSyncResult> => {
      return await window.api.ipc.invoke<ProviderModelSyncResult>(
        'db:providers:fetchModels',
        { id, options }
      )
    },
  },

  // Models
  models: {
    getAll: async (): Promise<ModelRecord[]> => {
      return await window.api.ipc.invoke<ModelRecord[]>('db:models:getAll')
    },
    getByProviderId: async (providerId: string): Promise<ModelRecord[]> => {
      return await window.api.ipc.invoke<ModelRecord[]>(
        'db:models:getByProviderId',
        {
          providerId,
        }
      )
    },
    create: async (data: Record<string, unknown>): Promise<ModelRecord> => {
      return await window.api.ipc.invoke<ModelRecord>('db:models:create', data)
    },
    createMany: async (
      models: Array<Record<string, unknown>>
    ): Promise<ModelRecord[]> => {
      return await window.api.ipc.invoke<ModelRecord[]>(
        'db:models:createMany',
        {
          models,
        }
      )
    },
    update: async (
      id: string,
      data: Record<string, unknown>
    ): Promise<ModelRecord | null> => {
      return await window.api.ipc.invoke<ModelRecord | null>('db:models:update', {
        id,
        data,
      })
    },
    delete: async (id: string): Promise<void> => {
      return await window.api.ipc.invoke<void>('db:models:delete', { id })
    },
    toggleEnabled: async (id: string): Promise<ModelRecord | null> => {
      return await window.api.ipc.invoke<ModelRecord | null>(
        'db:models:toggleEnabled',
        { id }
      )
    },
  },

  // Settings
  settings: {
    getAll: async () => {
      return await window.api.ipc.invoke('db:settings:getAll')
    },
    get: async (key: string) => {
      return await window.api.ipc.invoke('db:settings:get', { key })
    },
    set: async (key: string, value: unknown) => {
      return await window.api.ipc.invoke('db:settings:set', { key, value })
    },
    setMany: async (settings: Record<string, unknown>) => {
      return await window.api.ipc.invoke('db:settings:setMany', { settings })
    },
  },

  // Migration
  migration: {
    run: async (data: Record<string, unknown>): Promise<MigrationResult> => {
      return await window.api.ipc.invoke<MigrationResult>('db:migration:run', {
        data,
      })
    },
    verify: async (): Promise<MigrationStats> => {
      return await window.api.ipc.invoke<MigrationStats>('db:migration:verify')
    },
    clear: async (): Promise<void> => {
      return await window.api.ipc.invoke<void>('db:migration:clear')
    },
  },

  // MCP Servers
  mcp: {
    getAll: async (): Promise<MCPServerRecord[]> => {
      return await window.api.ipc.invoke<MCPServerRecord[]>('db:mcp:getAll')
    },
    getEnabled: async (): Promise<MCPServerRecord[]> => {
      return await window.api.ipc.invoke<MCPServerRecord[]>(
        'db:mcp:getEnabled'
      )
    },
    getById: async (id: string): Promise<MCPServerRecord | null> => {
      return await window.api.ipc.invoke<MCPServerRecord | null>(
        'db:mcp:getById',
        { id }
      )
    },
    create: async (data: Record<string, unknown>): Promise<MCPServerRecord> => {
      return await window.api.ipc.invoke<MCPServerRecord>('db:mcp:create', data)
    },
    update: async (
      id: string,
      data: Record<string, unknown>
    ): Promise<MCPServerRecord | null> => {
      return await window.api.ipc.invoke<MCPServerRecord | null>('db:mcp:update', {
        id,
        data,
      })
    },
    delete: async (id: string): Promise<void> => {
      return await window.api.ipc.invoke<void>('db:mcp:delete', { id })
    },
    toggleEnabled: async (id: string): Promise<MCPServerRecord | null> => {
      return await window.api.ipc.invoke<MCPServerRecord | null>(
        'db:mcp:toggleEnabled',
        { id }
      )
    },
    // Runtime status
    getServerStates: async (): Promise<MCPServerState[]> => {
      return await window.api.mcp.getServerStates()
    },
  },

  // Skills
  skills: {
    getDirectories: async (): Promise<SkillsDirectory[]> => {
      return await window.api.skills.getDirectories()
    },
    addDirectory: async (path: string) => {
      return await window.api.skills.addDirectory(path)
    },
    removeDirectory: async (id: string) => {
      return await window.api.skills.removeDirectory(id)
    },
    toggleDirectory: async (id: string) => {
      return await window.api.skills.toggleDirectory(id)
    },
    getAll: async (): Promise<Skill[]> => {
      return await window.api.skills.getAll()
    },
    getContent: async (path: string) => {
      return await window.api.skills.getContent(path)
    },
    getCount: async (path: string) => {
      return await window.api.skills.getCount(path)
    },
  },
}
