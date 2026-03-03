import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
import { startApiServer, getApiPort } from './apiServer'
import { startIpcBridge, fsService } from './ipcBridge'
import { initDatabase, closeDatabase } from './db'
import { initUpdater } from './updater'
import {
  ConversationService,
  MessageService,
  ProviderService,
  ModelService,
  SettingsService,
  AttachmentService,
  SearchService,
  PromptPresetService,
} from './db/services'
import { MCPService } from './db/services/mcpService'
import { SkillsService } from './db/services/skillsService'
import { DataMigration } from './db/migration'
import { WorkspaceService } from './services/workspaceService'
import { PermissionFileService } from './services/permissionFileService'
import { MemoryService } from './db/services/memoryService'
import { MemoryFileService } from './services/memoryFileService'
import { MemoryManager } from './services/memoryManager'
import { WindowThemeManager } from './services/windowThemeManager'
import { OpenAIOAuthService } from './services/openAIOAuthService'
import { ProviderModelSyncService } from './services/providerModelSyncService'
import { WebBrowserService } from './services/webBrowserService'

const permissionFileService = new PermissionFileService()
const themeManager = new WindowThemeManager()

// Memory input validation helpers
const VALID_MEMORY_TYPES = ['user', 'project', 'conversation'] as const
const VALID_MEMORY_CATEGORIES = [
  'preference',
  'knowledge',
  'decision',
  'pattern',
] as const
const MAX_CONTENT_LENGTH = 10000
const MAX_QUERY_LENGTH = 500
type MemoryType = (typeof VALID_MEMORY_TYPES)[number]
type MemoryCategory = (typeof VALID_MEMORY_CATEGORIES)[number]

function isMemoryType(value: unknown): value is MemoryType {
  return (
    typeof value === 'string' &&
    VALID_MEMORY_TYPES.includes(value as MemoryType)
  )
}

function isMemoryCategory(value: unknown): value is MemoryCategory {
  return (
    typeof value === 'string' &&
    VALID_MEMORY_CATEGORIES.includes(value as MemoryCategory)
  )
}

function validateMemoryInput(
  data: Record<string, unknown>,
  requiredFields: string[]
): string | null {
  for (const field of requiredFields) {
    if (field === 'type') {
      if (!isMemoryType(data.type)) {
        return `Invalid type: must be one of ${VALID_MEMORY_TYPES.join(', ')}`
      }
    } else if (field === 'category') {
      if (!isMemoryCategory(data.category)) {
        return `Invalid category: must be one of ${VALID_MEMORY_CATEGORIES.join(', ')}`
      }
    } else if (field === 'content') {
      const { content } = data
      if (typeof content !== 'string' || content.trim().length === 0) {
        return 'content must be a non-empty string'
      }
      if (content.length > MAX_CONTENT_LENGTH) {
        return `content exceeds max length of ${MAX_CONTENT_LENGTH}`
      }
    } else if (field === 'id') {
      const { id } = data
      if (typeof id !== 'string' || id.trim().length === 0) {
        return 'id must be a non-empty string'
      }
    } else if (field === 'query') {
      const { query } = data
      if (typeof query !== 'string' || query.trim().length === 0) {
        return 'query must be a non-empty string'
      }
      if (query.length > MAX_QUERY_LENGTH) {
        return `query exceeds max length of ${MAX_QUERY_LENGTH}`
      }
    }
  }
  return null
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    center: true,
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 24, y: 22 },
    title: 'Crow',
    ...themeManager.getPlatformConfig(),
  })

  themeManager.attach(mainWindow)

  // Load the renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Open DevTools in development
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools()
  }

  // Open external links in system default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  return mainWindow
}

app.whenReady().then(async () => {
  // Set dock icon in development
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock.setIcon(join(__dirname, '../../build/icon.png'))
  }

  // Initialize database
  console.log('🗄️  Initializing database...')
  initDatabase()

  // Register IPC handlers
  registerIpcHandlers()

  // Start servers
  const apiPort = await startApiServer(2323)
  console.log(`📡 API server started on port ${apiPort}`)
  startIpcBridge(3001)

  const mainWindow = createWindow()

  // Initialize updater IPC handlers in all environments.
  // Actual update checks are still guarded in updater.ts for packaged builds.
  initUpdater(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// IPC Handlers
function registerIpcHandlers() {
  // API port
  ipcMain.handle('api:get-port', () => {
    return getApiPort()
  })

  ipcMain.handle('api:get-version', () => {
    return app.getVersion()
  })

  // File operations
  ipcMain.handle('fs:readFile', async (_, { path }) => {
    const content = await fsService.readFile(path)
    return { content }
  })

  ipcMain.handle('fs:writeFile', async (_, { path, content }) => {
    const success = await fsService.writeFile(path, content)
    return { success }
  })

  ipcMain.handle('fs:listFiles', async (_, { path, pattern }) => {
    const files = await fsService.listFiles(path, pattern)
    return { files }
  })

  ipcMain.handle('fs:exists', async (_, { path }) => {
    const exists = await fsService.exists(path)
    return { exists }
  })

  ipcMain.handle('fs:mkdir', async (_, { path }) => {
    const success = await fsService.mkdir(path)
    return { success }
  })

  // Command execution
  ipcMain.handle('exec:command', async (_, { command, cwd }) => {
    return await fsService.executeCommand(command, cwd)
  })

  // Web
  ipcMain.handle(
    'web:search',
    async (_, { query, engine, limit, recencyDays, domains }) => {
      return {
        results: await WebBrowserService.search(query, {
          engine,
          limit,
          recencyDays,
          domains,
        }),
      }
    }
  )

  ipcMain.handle('web:fetch', async (_, { url, maxLength }) => {
    return {
      content: await WebBrowserService.fetch(url, maxLength),
    }
  })

  ipcMain.handle('web:openLogin', async (_, { engine }) => {
    await WebBrowserService.openLoginWindow(engine || 'google')
  })

  ipcMain.handle('web:sessionStatus', async () => {
    return {
      status: await WebBrowserService.getSessionStatus(),
    }
  })

  ipcMain.handle('web:clearSession', async () => {
    await WebBrowserService.clearSession()
  })

  // Workspace
  ipcMain.handle('workspace:get', () => {
    const path = fsService.getWorkspace()
    return { path }
  })

  ipcMain.handle('workspace:set', (_, { path }) => {
    const success = fsService.setWorkspace(path)
    return { success }
  })

  ipcMain.handle('workspace:select', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Workspace Folder',
    })

    if (!result.canceled && result.filePaths.length > 0) {
      const path = result.filePaths[0]
      fsService.setWorkspace(path)
      return { path }
    }

    return { path: null }
  })

  // Token 累加
  ipcMain.handle('conversation:addTokens', async (_, { id, inputTokens, outputTokens }) => {
    if (!id || typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
      throw new Error('Invalid params for conversation:addTokens')
    }
    await ConversationService.addTokens(id, inputTokens, outputTokens)
  })

  // Workspace management
  ipcMain.handle('workspace:createDefault', async (_, { conversationId }) => {
    const path = WorkspaceService.createDefaultWorkspace(conversationId)
    return { path }
  })

  ipcMain.handle('workspace:cleanup', async (_, { workspacePath }) => {
    return WorkspaceService.cleanupWorkspace(workspacePath)
  })

  ipcMain.handle('workspace:cleanupOrphans', async () => {
    const conversations = await ConversationService.getAll()
    const activeIds = conversations.map(c => c.id)
    const orphans = WorkspaceService.getOrphanedWorkspaces(activeIds)

    // 自动删除空目录
    let deletedCount = 0
    const nonEmpty: typeof orphans = []
    for (const orphan of orphans) {
      if (orphan.isEmpty) {
        WorkspaceService.forceDeleteWorkspace(orphan.path)
        deletedCount++
      } else {
        nonEmpty.push(orphan)
      }
    }
    return { deletedCount, nonEmpty }
  })

  ipcMain.handle('workspace:forceDelete', async (_, { path }) => {
    return { deleted: WorkspaceService.forceDeleteWorkspace(path) }
  })

  // Dialog - Select directory (with hidden files support)
  ipcMain.handle('dialog:selectDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'showHiddenFiles'],
      title: 'Select Directory',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Database - Conversations
  ipcMain.handle('db:conversations:getAll', async () => {
    return await ConversationService.getAll()
  })

  ipcMain.handle('db:conversations:getById', async (_, { id }) => {
    return await ConversationService.getById(id)
  })

  ipcMain.handle('db:conversations:getWithMessages', async (_, { id }) => {
    return await ConversationService.getWithMessages(id)
  })

  ipcMain.handle('db:conversations:create', async (_, data) => {
    return await ConversationService.create(data)
  })

  ipcMain.handle('db:conversations:update', async (_, { id, data }) => {
    return await ConversationService.update(id, data)
  })

  ipcMain.handle(
    'db:conversations:updateWorkspace',
    async (_, { id, workspace }) => {
      return await ConversationService.updateWorkspace(id, workspace)
    }
  )

  ipcMain.handle(
    'db:conversations:updateSystemPrompt',
    async (_, { id, systemPrompt }) => {
      return await ConversationService.updateSystemPrompt(id, systemPrompt)
    }
  )

  ipcMain.handle('db:conversations:delete', async (_, { id }) => {
    return await ConversationService.delete(id)
  })

  ipcMain.handle(
    'db:conversations:addTokens',
    async (_, { id, inputTokens, outputTokens }) => {
      if (
        !id ||
        typeof inputTokens !== 'number' ||
        typeof outputTokens !== 'number'
      ) {
        throw new Error('Invalid params for addTokens')
      }
      return await ConversationService.addTokens(id, inputTokens, outputTokens)
    }
  )

  // Database - Messages
  ipcMain.handle(
    'db:messages:getByConversationId',
    async (_, { conversationId }) => {
      return await MessageService.getByConversationId(conversationId)
    }
  )

  ipcMain.handle(
    'db:messages:getAllWithTools',
    async (_, { conversationId }) => {
      return await MessageService.getAllWithTools(conversationId)
    }
  )

  ipcMain.handle('db:messages:create', async (_, data) => {
    return await MessageService.create(data)
  })

  ipcMain.handle('db:messages:updateContent', async (_, { id, content }) => {
    return await MessageService.updateContent(id, content)
  })

  ipcMain.handle('db:messages:addToolCall', async (_, { messageId, data }) => {
    return await MessageService.addToolCall(messageId, data)
  })

  ipcMain.handle(
    'db:messages:addToolResult',
    async (_, { toolCallId, data }) => {
      return await MessageService.addToolResult(toolCallId, data)
    }
  )

  // 上下文压缩：批量标记消息为已压缩
  ipcMain.handle('db:messages:markCompressed', async (_, { messageIds }) => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      throw new Error('messageIds must be a non-empty array')
    }
    if (messageIds.length > 100) {
      throw new Error('messageIds exceeds max length of 100')
    }
    // M3: 校验数组元素类型，防止非 string 元素导致 SQL 异常
    if (
      !messageIds.every(
        (id: unknown) => typeof id === 'string' && id.length > 0
      )
    ) {
      throw new Error('messageIds must contain only non-empty strings')
    }
    await MessageService.markCompressed(messageIds)
    return { success: true }
  })

  // 上下文压缩：创建摘要消息
  ipcMain.handle('db:messages:createSummary', async (_, data) => {
    if (!data.id || !data.conversationId || !data.content || !data.summaryOf) {
      throw new Error(
        'Missing required fields: id, conversationId, content, summaryOf'
      )
    }
    if (!Array.isArray(data.summaryOf)) {
      throw new Error('summaryOf must be an array of message IDs')
    }
    // M2: 校验 timestamp，缺失时使用当前时间
    const timestamp =
      data.timestamp && typeof data.timestamp === 'number'
        ? new Date(data.timestamp)
        : new Date()
    return await MessageService.createSummary({
      ...data,
      timestamp,
    })
  })

  // Database - Providers
  ipcMain.handle('db:providers:getAll', async () => {
    return await ProviderService.getAll()
  })

  ipcMain.handle('db:providers:getEnabled', async () => {
    return await ProviderService.getEnabled()
  })

  ipcMain.handle('db:providers:getById', async (_, { id }) => {
    return await ProviderService.getById(id)
  })

  ipcMain.handle('db:providers:getByName', async (_, { name }) => {
    return await ProviderService.getByName(name)
  })

  ipcMain.handle('db:providers:create', async (_, data) => {
    return await ProviderService.create(data)
  })

  ipcMain.handle('db:providers:update', async (_, { id, data }) => {
    return await ProviderService.update(id, data)
  })

  ipcMain.handle('db:providers:delete', async (_, { id }) => {
    return await ProviderService.delete(id)
  })

  ipcMain.handle('db:providers:toggleEnabled', async (_, { id }) => {
    return await ProviderService.toggleEnabled(id)
  })

  ipcMain.handle('db:providers:resolveCredentials', async (_, { id }) => {
    return await OpenAIOAuthService.resolveProviderCredentials(id)
  })

  ipcMain.handle('db:providers:oauthImportOpenClaw', async (_, { id }) => {
    return await OpenAIOAuthService.importFromOpenClaw(id)
  })

  ipcMain.handle('db:providers:oauthStartLogin', async (_, { id }) => {
    return await OpenAIOAuthService.startLogin(id)
  })

  ipcMain.handle('db:providers:oauthGetLoginSession', async (_, { sessionId }) => {
    return await OpenAIOAuthService.pollLoginSession(sessionId)
  })

  ipcMain.handle('db:providers:oauthCancelLogin', async (_, { sessionId }) => {
    return await OpenAIOAuthService.cancelLogin(sessionId)
  })

  ipcMain.handle('db:providers:oauthSetManual', async (_, { id, data }) => {
    return await OpenAIOAuthService.setManualCredentials(id, data)
  })

  ipcMain.handle('db:providers:oauthStatus', async (_, { id }) => {
    return await OpenAIOAuthService.getOAuthStatus(id)
  })

  ipcMain.handle('db:providers:oauthLogout', async (_, { id }) => {
    return await OpenAIOAuthService.logout(id)
  })

  ipcMain.handle('db:providers:fetchModels', async (_, { id, options }) => {
    return await ProviderModelSyncService.syncProviderModels(id, options)
  })

  // Database - Models
  ipcMain.handle('db:models:getAll', async () => {
    return await ModelService.getAll()
  })

  ipcMain.handle('db:models:getByProviderId', async (_, { providerId }) => {
    return await ModelService.getByProviderId(providerId)
  })

  ipcMain.handle('db:models:create', async (_, data) => {
    return await ModelService.create(data)
  })

  ipcMain.handle('db:models:createMany', async (_, { models }) => {
    return await ModelService.createMany(models)
  })

  ipcMain.handle('db:models:update', async (_, { id, data }) => {
    return await ModelService.update(id, data)
  })

  ipcMain.handle('db:models:delete', async (_, { id }) => {
    return await ModelService.delete(id)
  })

  ipcMain.handle('db:models:toggleEnabled', async (_, { id }) => {
    return await ModelService.toggleEnabled(id)
  })

  // Database - Settings
  ipcMain.handle('db:settings:getAll', async () => {
    return await SettingsService.getAll()
  })

  ipcMain.handle('db:settings:get', async (_, { key }) => {
    return await SettingsService.get(key)
  })

  ipcMain.handle('db:settings:set', async (_, { key, value }) => {
    return await SettingsService.set(key, value)
  })

  ipcMain.handle('db:settings:setMany', async (_, { settings }) => {
    return await SettingsService.setMany(settings)
  })

  // Database - Migration
  ipcMain.handle('db:migration:run', async (_, { data }) => {
    return await DataMigration.runMigration(data)
  })

  ipcMain.handle('db:migration:verify', async () => {
    return await DataMigration.verifyMigration()
  })

  ipcMain.handle('db:migration:clear', async () => {
    return await DataMigration.clearDatabase()
  })

  // Database - Search
  ipcMain.handle('db:search', async (_, { query }) => {
    return await SearchService.search(query)
  })

  ipcMain.handle('db:search:rebuild', async () => {
    await SearchService.rebuildIndex()
    return { success: true }
  })

  // Database - MCP Servers
  ipcMain.handle('db:mcp:getAll', async () => {
    return await MCPService.getAll()
  })

  ipcMain.handle('db:mcp:getEnabled', async () => {
    return await MCPService.getEnabled()
  })

  ipcMain.handle('db:mcp:getById', async (_, { id }) => {
    return await MCPService.getById(id)
  })

  ipcMain.handle('db:mcp:create', async (_, data) => {
    // Drizzle handles JSON serialization automatically via mode: 'json'
    const result = await MCPService.create(data)
    // Connect the new server if enabled
    if (result && result.enabled) {
      try {
        const { connectMcpServer } = await import('../api/services/mcp/init')
        await connectMcpServer(result)
      } catch (error) {
        console.error('Failed to connect MCP server:', error)
      }
    }
    return result
  })

  ipcMain.handle('db:mcp:update', async (_, { id, data }) => {
    return await MCPService.update(id, data)
  })

  ipcMain.handle('db:mcp:delete', async (_, { id }) => {
    // Get server name before deleting
    const server = await MCPService.getById(id)
    if (server) {
      try {
        const { disconnectMcpServer } = await import('../api/services/mcp/init')
        await disconnectMcpServer(server.name)
      } catch (error) {
        console.error('Failed to disconnect MCP server:', error)
      }
    }
    return await MCPService.delete(id)
  })

  ipcMain.handle('db:mcp:toggleEnabled', async (_, { id }) => {
    const result = await MCPService.toggleEnabled(id)
    if (result) {
      try {
        if (result.enabled) {
          const { connectMcpServer } = await import('../api/services/mcp/init')
          await connectMcpServer(result)
        } else {
          const { disconnectMcpServer } =
            await import('../api/services/mcp/init')
          await disconnectMcpServer(result.name)
        }
      } catch (error) {
        console.error('Failed to toggle MCP server connection:', error)
      }
    }
    return result
  })

  // MCP Runtime Status
  ipcMain.handle('mcp:getServerStates', async () => {
    try {
      const { mcpManager } = await import('../api/services/mcp/manager')
      return mcpManager.getServerStates()
    } catch (error) {
      console.error('Failed to get MCP server states:', error)
      return []
    }
  })

  // Database - Attachments
  ipcMain.handle('db:attachments:create', async (_, data) => {
    // Convert base64 string to Buffer if needed (renderer sends base64)
    if (typeof data.data === 'string') {
      data.data = Buffer.from(data.data, 'base64')
    }
    return await AttachmentService.create(data)
  })

  ipcMain.handle('db:attachments:getByMessageId', async (_, { messageId }) => {
    return await AttachmentService.getByMessageId(messageId)
  })

  ipcMain.handle(
    'db:attachments:getPreviewsByMessageId',
    async (_, { messageId }) => {
      return await AttachmentService.getPreviewsByMessageId(messageId)
    }
  )

  ipcMain.handle('db:attachments:getById', async (_, { id }) => {
    return await AttachmentService.getById(id)
  })

  ipcMain.handle('db:attachments:getBase64', async (_, { id }) => {
    return await AttachmentService.getBase64(id)
  })

  ipcMain.handle('db:attachments:updateNote', async (_, { id, note }) => {
    await AttachmentService.updateNote(id, note)
    return { success: true }
  })

  ipcMain.handle('db:attachments:delete', async (_, { id }) => {
    await AttachmentService.delete(id)
    return { success: true }
  })

  // Health check - verify API server is running
  ipcMain.handle('check-server-health', async () => {
    try {
      const response = await fetch('http://localhost:2323/health')
      return response.ok
    } catch {
      return false
    }
  })

  // Database - Skills Directories
  ipcMain.handle('db:skills:getDirectories', async () => {
    return await SkillsService.getAll()
  })

  ipcMain.handle('db:skills:addDirectory', async (_, { path }) => {
    return await SkillsService.create(path)
  })

  ipcMain.handle('db:skills:removeDirectory', async (_, { id }) => {
    await SkillsService.delete(id)
    return { success: true }
  })

  ipcMain.handle('db:skills:toggleDirectory', async (_, { id }) => {
    await SkillsService.toggleEnabled(id)
    return { success: true }
  })

  ipcMain.handle('db:skills:getAll', async () => {
    return await SkillsService.getAllSkills()
  })

  ipcMain.handle('db:skills:getContent', async (_, { path }) => {
    return SkillsService.getSkillContent(path)
  })

  ipcMain.handle('db:skills:getCount', async (_, { path }) => {
    return SkillsService.getSkillCount(path)
  })

  // Database - Prompt Presets
  ipcMain.handle('db:promptPresets:getAll', async () => {
    return await PromptPresetService.getAll()
  })

  ipcMain.handle('db:promptPresets:getById', async (_, { id }) => {
    return await PromptPresetService.getById(id)
  })

  ipcMain.handle('db:promptPresets:create', async (_, data) => {
    return await PromptPresetService.create(data)
  })

  ipcMain.handle('db:promptPresets:update', async (_, { id, data }) => {
    return await PromptPresetService.update(id, data)
  })

  ipcMain.handle('db:promptPresets:delete', async (_, { id }) => {
    await PromptPresetService.delete(id)
    return { success: true }
  })

  // Permissions
  ipcMain.handle('permissions:load', async (_event, { workspacePath }) => {
    return permissionFileService.loadRules(workspacePath)
  })

  ipcMain.handle(
    'permissions:addRule',
    async (_event, { rule, source, workspacePath }) => {
      permissionFileService.addRule(rule, source, workspacePath)
      return { success: true }
    }
  )

  ipcMain.handle(
    'permissions:removeRule',
    async (_event, { ruleId, source, workspacePath }) => {
      permissionFileService.removeRule(ruleId, source, workspacePath)
      return { success: true }
    }
  )

  // Memory
  ipcMain.handle('memory:getAll', async () => {
    try {
      return await MemoryService.getAll()
    } catch (error) {
      console.error('memory:getAll failed:', error)
      return []
    }
  })

  ipcMain.handle('memory:getByType', async (_, { type }) => {
    const err = validateMemoryInput({ type }, ['type'])
    if (err) throw new Error(err)
    try {
      return await MemoryService.getByType(type)
    } catch (error) {
      console.error('memory:getByType failed:', error)
      return []
    }
  })

  ipcMain.handle('memory:create', async (_, data) => {
    const err = validateMemoryInput(data, ['type', 'category', 'content'])
    if (err) throw new Error(err)
    try {
      return await MemoryService.create(data)
    } catch (error) {
      console.error('memory:create failed:', error)
      throw error
    }
  })

  ipcMain.handle('memory:update', async (_, { id, data }) => {
    const err = validateMemoryInput({ id }, ['id'])
    if (err) throw new Error(err)
    try {
      return await MemoryService.update(id, data)
    } catch (error) {
      console.error('memory:update failed:', error)
      throw error
    }
  })

  ipcMain.handle('memory:delete', async (_, { id }) => {
    const err = validateMemoryInput({ id }, ['id'])
    if (err) throw new Error(err)
    try {
      await MemoryService.delete(id)
      return { success: true }
    } catch (error) {
      console.error('memory:delete failed:', error)
      throw error
    }
  })

  ipcMain.handle('memory:search', async (_, { query }) => {
    const err = validateMemoryInput({ query }, ['query'])
    if (err) throw new Error(err)
    try {
      return await MemoryService.search(query)
    } catch (error) {
      console.error('memory:search failed:', error)
      return []
    }
  })

  ipcMain.handle('memory:upsert', async (_, data) => {
    const err = validateMemoryInput(data, ['type', 'category', 'content'])
    if (err) throw new Error(err)
    try {
      return await MemoryService.upsertMemory(data)
    } catch (error) {
      console.error('memory:upsert failed:', error)
      throw error
    }
  })

  ipcMain.handle('memory:syncToFile', async (_, { memory, workspacePath }) => {
    try {
      return await MemoryFileService.syncMemoryToFile(memory, workspacePath)
    } catch (error) {
      console.error('memory:syncToFile failed:', error)
      return ''
    }
  })

  // Memory extraction pipeline (P1)
  ipcMain.handle(
    'memory:extract',
    async (
      _,
      { messages, providerId, modelId, workspacePath, conversationId }
    ) => {
      try {
        // C1 fix: Resolve provider credentials from DB — never accept apiKey from renderer
        const provider = await ProviderService.getById(providerId)
        if (!provider) {
          console.warn(
            'memory:extract — provider not found:',
            providerId
          )
          return { extracted: 0, saved: 0 }
        }
        const model = await ModelService.getById(modelId)
        if (!model) {
          console.warn('memory:extract — model not found:', modelId)
          return { extracted: 0, saved: 0 }
        }

        const resolvedCredentials =
          await OpenAIOAuthService.resolveProviderCredentials(providerId)

        const config = {
          apiKey: resolvedCredentials.apiKey,
          model: model.modelId,
          baseURL: provider.baseURL || undefined,
          apiFormat: provider.apiFormat || 'chat-completions',
          temperature: 0.1,
          maxTokens: 4096,
          thinkingEnabled: false,
        }

        // TODO(C2): MemoryExtractor lives in api/ layer but is used by main process.
        // In Electron, both run in the same Node.js process so this is safe at runtime.
        // Future: move extraction logic to main/services or route via HTTP API.
        const { MemoryExtractor } =
          await import('../api/services/memory/extractor')
        const EXTRACTION_TIMEOUT = 30000 // 30 seconds
        const extractWithTimeout = Promise.race([
          MemoryExtractor.extract(messages, provider.type, config),
          new Promise<
            import('../api/services/memory/extractor').ExtractedMemory[]
          >((_, reject) =>
            setTimeout(
              () => reject(new Error('Memory extraction timed out')),
              EXTRACTION_TIMEOUT
            )
          ),
        ])
        const extracted = await extractWithTimeout

        if (extracted.length === 0) {
          return { extracted: 0, saved: 0 }
        }

        let saved = 0
        for (const item of extracted) {
          // Determine memory type: preference/pattern → user, knowledge/decision → project (if workspace)
          const memoryType =
            ['preference', 'pattern'].includes(item.category) || !workspacePath
              ? 'user'
              : 'project'

          const { isNew } = await MemoryService.upsertMemory({
            type: memoryType,
            category: item.category,
            content: item.content,
            tags: item.tags ? JSON.stringify(item.tags) : undefined,
            source: 'auto',
            conversationId: conversationId || undefined,
          })

          // Sync to .md file
          await MemoryFileService.syncMemoryToFile(
            {
              type: memoryType,
              category: item.category,
              content: item.content,
              source: 'auto',
              tags: item.tags,
            },
            workspacePath || undefined
          )

          if (isNew) saved++
        }

        return { extracted: extracted.length, saved }
      } catch (error) {
        console.error('Memory extraction failed:', error)
        return { extracted: 0, saved: 0 }
      }
    }
  )

  ipcMain.handle(
    'memory:getRelevant',
    async (_, { workspacePath, userMessage }) => {
      try {
        return await MemoryManager.getRelevantMemories(
          workspacePath,
          userMessage
        )
      } catch (error) {
        console.error('memory:getRelevant failed:', error)
        return ''
      }
    }
  )

  ipcMain.handle(
    'memory:remember',
    async (_, { content, type, category, workspacePath }) => {
      const err = validateMemoryInput({ content }, ['content'])
      if (err) throw new Error(err)
      try {
        const resolvedType = type || 'user'
        const resolvedCategory = category || 'knowledge'

        // Reuse MemoryFileService.resolveFilePath to avoid duplicating path logic (I11)
        const targetFilePath = MemoryFileService.resolveFilePath(
          resolvedType,
          resolvedCategory,
          workspacePath || undefined
        )

        // Write to SQLite (with filePath for precise /forget targeting)
        const memory = await MemoryService.create({
          type: resolvedType,
          category: resolvedCategory,
          content,
          source: 'manual',
          filePath: targetFilePath,
        })

        // Write to .md file
        if (targetFilePath) {
          const frontmatter = { type: resolvedType, source: 'manual' }
          MemoryFileService.ensureDirectory(join(targetFilePath, '..'))
          await MemoryFileService.appendToFile(
            targetFilePath,
            content,
            frontmatter
          )
        }

        return memory
      } catch (error) {
        console.error('memory:remember failed:', error)
        throw error
      }
    }
  )

  ipcMain.handle(
    'memory:getByConversationId',
    async (_, { conversationId }) => {
      try {
        return await MemoryService.getByConversationId(conversationId)
      } catch (error) {
        console.error('memory:getByConversationId failed:', error)
        return []
      }
    }
  )

  ipcMain.handle('memory:forget', async (_, { keyword, workspacePath }) => {
    const err = validateMemoryInput({ query: keyword }, ['query'])
    if (err) throw new Error(err)
    try {
      // Search for matching memories — cap at 20 to prevent mass deletion
      const MAX_FORGET = 20
      const allMatches = await MemoryService.search(keyword)
      const matches = allMatches.slice(0, MAX_FORGET)
      let deletedCount = 0

      for (const match of matches) {
        // M3: Remove from .md files FIRST, then delete from DB.
        // If .md removal fails, the DB record remains and can be retried via /forget.
        if (match.filePath) {
          await MemoryFileService.removeFromFile(match.filePath, match.content)
        } else {
          // Try both user and project dirs
          const userDir = MemoryFileService.getUserMemoryDir()
          const files = await MemoryFileService.readAllMemoryFiles(userDir)
          for (const file of files) {
            await MemoryFileService.removeFromFile(file.filePath, match.content)
          }
          if (workspacePath) {
            const projectDir =
              MemoryFileService.getProjectMemoryDir(workspacePath)
            const projectFiles =
              await MemoryFileService.readAllMemoryFiles(projectDir)
            for (const file of projectFiles) {
              await MemoryFileService.removeFromFile(
                file.filePath,
                match.content
              )
            }
          }
        }

        // Delete from SQLite after .md cleanup
        await MemoryService.delete(match.id)
        deletedCount++
      }

      return { deletedCount }
    } catch (error) {
      console.error('memory:forget failed:', error)
      return { deletedCount: 0 }
    }
  })

  // P2-18: Export all memories as JSON
  ipcMain.handle('memory:export', async () => {
    try {
      return await MemoryService.exportAll()
    } catch (error) {
      console.error('memory:export failed:', error)
      return []
    }
  })

  // P2-18: Import memories from JSON array (with dedup via upsert)
  ipcMain.handle('memory:import', async (_, { memories: items }) => {
    try {
      if (!Array.isArray(items)) throw new Error('Expected array')

      // C2: Server-side validation constants
      const VALID_TYPES = ['user', 'project', 'conversation']
      const VALID_CATEGORIES = [
        'preference',
        'knowledge',
        'decision',
        'pattern',
      ]
      const MAX_CONTENT_LENGTH = 10000
      const MAX_IMPORT_ITEMS = 500

      const safeItems = items.slice(0, MAX_IMPORT_ITEMS)
      let imported = 0
      let skipped = 0
      for (const item of safeItems) {
        if (
          !item.content ||
          typeof item.content !== 'string' ||
          !item.type ||
          !VALID_TYPES.includes(item.type) ||
          !item.category ||
          !VALID_CATEGORIES.includes(item.category) ||
          !item.source ||
          typeof item.source !== 'string'
        ) {
          skipped++
          continue
        }
        // Cap content length
        const content = item.content.slice(0, MAX_CONTENT_LENGTH)
        // Validate tags is string if present
        const tags = typeof item.tags === 'string' ? item.tags : undefined

        const { isNew } = await MemoryService.upsertMemory({
          type: item.type,
          category: item.category,
          content,
          tags,
          source: item.source,
          conversationId: item.conversationId || undefined,
        })
        if (isNew) imported++
        else skipped++
      }
      return { imported, skipped }
    } catch (error) {
      console.error('memory:import failed:', error)
      throw error
    }
  })

  // P2-15: Delete all memories of a given type
  ipcMain.handle('memory:deleteByType', async (_, { type }) => {
    const err = validateMemoryInput({ type }, ['type'])
    if (err) throw new Error(err)
    try {
      await MemoryService.deleteByType(type)
      return { success: true }
    } catch (error) {
      console.error('memory:deleteByType failed:', error)
      throw error
    }
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    closeDatabase()
    app.quit()
  }
})

app.on('before-quit', () => {
  closeDatabase()
})
