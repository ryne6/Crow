import { contextBridge, ipcRenderer } from 'electron'
import type { IpcApi } from '../shared/types/ipc'

// macOS Tahoe = macOS 16+（sandbox 模式下 os 模块不可用，用 Electron 的 getSystemVersion）
const isMacTahoe =
  process.platform === 'darwin' &&
  typeof process.getSystemVersion === 'function' &&
  parseInt(process.getSystemVersion().split('.')[0], 10) >= 16

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  isMacTahoe,
})

// Expose file system and workspace APIs
const api: IpcApi = {
  api: {
    getPort: () => ipcRenderer.invoke('api:get-port'),
    getVersion: () => ipcRenderer.invoke('api:get-version'),
  },
  fs: {
    readFile: (path: string) => ipcRenderer.invoke('fs:readFile', { path }),
    writeFile: (path: string, content: string) =>
      ipcRenderer.invoke('fs:writeFile', { path, content }),
    editFile: (
      path: string,
      oldText: string,
      newText: string,
      replaceAll = false
    ) =>
      ipcRenderer.invoke('fs:editFile', {
        path,
        oldText,
        newText,
        replaceAll,
      }),
    glob: (pattern: string, path?: string) =>
      ipcRenderer.invoke('fs:glob', { pattern, path }),
    grep: (
      pattern: string,
      path?: string,
      options?: { glob?: string; ignoreCase?: boolean; maxResults?: number }
    ) => ipcRenderer.invoke('fs:grep', { pattern, path, options }),
    listFiles: (path: string, pattern?: string) =>
      ipcRenderer.invoke('fs:listFiles', { path, pattern }),
    exists: (path: string) => ipcRenderer.invoke('fs:exists', { path }),
    mkdir: (path: string) => ipcRenderer.invoke('fs:mkdir', { path }),
  },
  exec: {
    command: (command: string, cwd?: string) =>
      ipcRenderer.invoke('exec:command', { command, cwd }),
  },
  git: {
    status: (path?: string) => ipcRenderer.invoke('git:status', { path }),
    diff: (path?: string, staged?: boolean, file?: string) =>
      ipcRenderer.invoke('git:diff', { path, staged, file }),
    log: (path?: string, maxCount?: number) =>
      ipcRenderer.invoke('git:log', { path, maxCount }),
    commit: (path: string | undefined, message: string, files?: string[]) =>
      ipcRenderer.invoke('git:commit', { path, message, files }),
    push: (path?: string, remote?: string, branch?: string) =>
      ipcRenderer.invoke('git:push', { path, remote, branch }),
    checkout: (path: string | undefined, branch: string, create?: boolean) =>
      ipcRenderer.invoke('git:checkout', { path, branch, create }),
  },
  web: {
    fetch: (url: string, maxLength?: number) =>
      ipcRenderer.invoke('web:fetch', { url, maxLength }),
    search: (
      query: string,
      limit?: number,
      recencyDays?: number,
      domains?: string[],
      engine?: 'google' | 'bing'
    ) =>
      ipcRenderer.invoke('web:search', {
        query,
        limit,
        recencyDays,
        domains,
        engine,
      }),
    openLogin: (engine: 'google' | 'bing') =>
      ipcRenderer.invoke('web:openLogin', { engine }),
    sessionStatus: () => ipcRenderer.invoke('web:sessionStatus'),
    clearSession: () => ipcRenderer.invoke('web:clearSession'),
  },
  workspace: {
    get: () => ipcRenderer.invoke('workspace:get'),
    set: (path: string) => ipcRenderer.invoke('workspace:set', { path }),
    select: () => ipcRenderer.invoke('workspace:select'),
    createDefault: (conversationId: string) =>
      ipcRenderer.invoke('workspace:createDefault', { conversationId }),
    cleanup: (workspacePath: string) =>
      ipcRenderer.invoke('workspace:cleanup', { workspacePath }),
    cleanupOrphans: () => ipcRenderer.invoke('workspace:cleanupOrphans'),
    forceDelete: (path: string) =>
      ipcRenderer.invoke('workspace:forceDelete', { path }),
  },
  conversation: {
    addTokens: (id: string, inputTokens: number, outputTokens: number) =>
      ipcRenderer.invoke('conversation:addTokens', { id, inputTokens, outputTokens }),
  },
  ipc: {
    invoke: <T = unknown>(channel: string, ...args: unknown[]) =>
      ipcRenderer.invoke(channel, ...args) as Promise<T>,
  },
  search: {
    query: query => ipcRenderer.invoke('db:search', { query }),
    rebuildIndex: () => ipcRenderer.invoke('db:search:rebuild'),
  },
  attachments: {
    create: data => ipcRenderer.invoke('db:attachments:create', data),
    getByMessageId: messageId =>
      ipcRenderer.invoke('db:attachments:getByMessageId', { messageId }),
    getPreviewsByMessageId: messageId =>
      ipcRenderer.invoke('db:attachments:getPreviewsByMessageId', {
        messageId,
      }),
    getById: id => ipcRenderer.invoke('db:attachments:getById', { id }),
    getBase64: id => ipcRenderer.invoke('db:attachments:getBase64', { id }),
    updateNote: (id, note) =>
      ipcRenderer.invoke('db:attachments:updateNote', { id, note }),
    delete: id => ipcRenderer.invoke('db:attachments:delete', { id }),
  },
  mcp: {
    getServerStates: () => ipcRenderer.invoke('mcp:getServerStates'),
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  },
  skills: {
    getDirectories: () => ipcRenderer.invoke('db:skills:getDirectories'),
    addDirectory: (path: string) =>
      ipcRenderer.invoke('db:skills:addDirectory', { path }),
    removeDirectory: (id: string) =>
      ipcRenderer.invoke('db:skills:removeDirectory', { id }),
    toggleDirectory: (id: string) =>
      ipcRenderer.invoke('db:skills:toggleDirectory', { id }),
    getAll: () => ipcRenderer.invoke('db:skills:getAll'),
    getContent: (path: string) =>
      ipcRenderer.invoke('db:skills:getContent', { path }),
    getCount: (path: string) =>
      ipcRenderer.invoke('db:skills:getCount', { path }),
  },
  promptPresets: {
    getAll: () => ipcRenderer.invoke('db:promptPresets:getAll'),
    getById: (id: string) =>
      ipcRenderer.invoke('db:promptPresets:getById', { id }),
    create: (data: { name: string; content: string }) =>
      ipcRenderer.invoke('db:promptPresets:create', data),
    update: (id: string, data: { name?: string; content?: string }) =>
      ipcRenderer.invoke('db:promptPresets:update', { id, data }),
    delete: (id: string) =>
      ipcRenderer.invoke('db:promptPresets:delete', { id }),
  },
  permissions: {
    load: (workspacePath?: string) =>
      ipcRenderer.invoke('permissions:load', { workspacePath }),
    addRule: (rule, source, workspacePath) =>
      ipcRenderer.invoke('permissions:addRule', {
        rule,
        source,
        workspacePath,
      }),
    removeRule: (ruleId, source, workspacePath) =>
      ipcRenderer.invoke('permissions:removeRule', {
        ruleId,
        source,
        workspacePath,
      }),
  },
  memory: {
    getAll: () => ipcRenderer.invoke('memory:getAll'),
    getByType: (type: string) =>
      ipcRenderer.invoke('memory:getByType', { type }),
    create: data => ipcRenderer.invoke('memory:create', data),
    update: (id, data) =>
      ipcRenderer.invoke('memory:update', { id, data }),
    delete: (id: string) => ipcRenderer.invoke('memory:delete', { id }),
    search: (query: string) => ipcRenderer.invoke('memory:search', { query }),
    getRelevant: (workspacePath: string | null, userMessage: string) =>
      ipcRenderer.invoke('memory:getRelevant', { workspacePath, userMessage }),
    remember: (
      content: string,
      type?: string,
      workspacePath?: string,
      category?: string
    ) =>
      ipcRenderer.invoke('memory:remember', {
        content,
        type,
        workspacePath,
        category,
      }),
    forget: (keyword: string, workspacePath?: string) =>
      ipcRenderer.invoke('memory:forget', { keyword, workspacePath }),
    getByConversationId: (conversationId: string) =>
      ipcRenderer.invoke('memory:getByConversationId', { conversationId }),
    upsert: data => ipcRenderer.invoke('memory:upsert', data),
    syncToFile: (memory, workspacePath) =>
      ipcRenderer.invoke('memory:syncToFile', { memory, workspacePath }),
    extract: data => ipcRenderer.invoke('memory:extract', data),
    export: () => ipcRenderer.invoke('memory:export'),
    import: memories =>
      ipcRenderer.invoke('memory:import', { memories }),
    deleteByType: (type: string) =>
      ipcRenderer.invoke('memory:deleteByType', { type }),
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: callback => {
      const handler = (
        _event: unknown,
        status: Parameters<typeof callback>[0]
      ) => callback(status)
      ipcRenderer.on('updater:status', handler)
      return () => ipcRenderer.removeListener('updater:status', handler)
    },
  },
}

contextBridge.exposeInMainWorld('api', api)
