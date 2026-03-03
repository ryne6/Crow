import axios from 'axios'
import { TOOL_PERMISSION_PREFIX } from '~shared/types/toolPermissions'
import type { PermissionRule, HooksConfig } from '~shared/types/toolPermissions'
import { PermissionEngine } from '~shared/permissions/engine'

// Lazy-loaded MCP manager to avoid SDK side effects at import time
let mcpManagerInstance: typeof import('../../mcp/manager').mcpManager | null =
  null

async function getMcpManager() {
  if (!mcpManagerInstance) {
    const { mcpManager } = await import('../../mcp/manager')
    mcpManagerInstance = mcpManager
  }
  return mcpManagerInstance
}

// 模块级单例
const permissionEngine = new PermissionEngine()

export interface ToolExecutionOptions {
  toolCallId?: string
  toolPermissions?: { allowAll: boolean }
  allowOnceTools?: string[]
  // P0 新增
  sessionApprovedTools?: Set<string>
  // P1 新增
  permissionRules?: PermissionRule[]
  // P2 预留
  hooks?: HooksConfig
  sandboxMode?: 'read-only' | 'workspace-write' | 'full-access'
  webSearchEngine?: 'google' | 'bing'
}

const IPC_BRIDGE_BASE = 'http://localhost:3001'

const TODO_STATUS_MARKERS: Record<string, string> = {
  todo: ' ',
  in_progress: '~',
  done: 'x',
}

interface TodoInput {
  status: string
  title?: string
  notes?: string
}

interface GrepResult {
  file: string
  line: number
  content: string
}

interface WebSearchResult {
  title: string
  url?: string
  snippet?: string
}

interface ListFileEntry {
  name: string
  isDirectory: boolean
  size: number
}

function getBridgeErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const responseData = error.response?.data
    const errorMessage =
      responseData !== null &&
      typeof responseData === 'object' &&
      'error' in responseData &&
      typeof responseData.error === 'string'
        ? responseData.error
        : undefined
    if (errorMessage) return errorMessage
  }

  if (error instanceof Error) return error.message
  return 'Unknown error'
}

export class ToolExecutor {
  async execute(
    toolName: string,
    input: Record<string, unknown>,
    options: ToolExecutionOptions = {}
  ): Promise<string> {
    const decision = permissionEngine.evaluate(toolName, input, {
      allowAll: options.toolPermissions?.allowAll ?? false,
      allowOnceTools: options.allowOnceTools,
      sessionApprovedTools: options.sessionApprovedTools,
      permissionRules: options.permissionRules,
    })

    if (decision.action === 'deny') {
      return `Error: Tool "${toolName}" was denied. ${decision.reason || ''}`
    }

    if (decision.action === 'ask') {
      const payload = {
        kind: 'permission_request',
        toolName,
        toolCallId: options.toolCallId,
      }
      return `${TOOL_PERMISSION_PREFIX}${JSON.stringify(payload)}`
    }

    // decision.action === 'allow' → 继续执行

    // Initialize MCP manager and check for MCP tools
    const mcpManager = await getMcpManager()
    if (mcpManager.isMCPTool(toolName)) {
      try {
        return await mcpManager.callTool(toolName, input)
      } catch (error: unknown) {
        return `Error: ${getBridgeErrorMessage(error) || 'MCP tool execution failed'}`
      }
    }

    try {
      switch (toolName) {
        case 'Read':
          return await this.readFile(this.getStringValue(input, 'path'))

        case 'Write':
          return await this.writeFile(
            this.getStringValue(input, 'path'),
            this.getStringValue(input, 'content')
          )

        case 'Edit':
          return await this.editFile(
            this.getStringValue(input, 'path'),
            this.getStringValue(input, 'old_text'),
            this.getStringValue(input, 'new_text'),
            this.getOptionalBooleanValue(input, 'replace_all')
          )

        case 'LS':
          return await this.listFiles(
            this.getStringValue(input, 'path'),
            this.getOptionalStringValue(input, 'pattern')
          )

        case 'Bash':
          return await this.executeCommand(
            this.getStringValue(input, 'command'),
            this.getOptionalStringValue(input, 'cwd')
          )

        case 'TodoWrite':
          return this.formatTodoList(input)

        case 'Glob':
          return await this.globFiles(
            this.getStringValue(input, 'pattern'),
            this.getOptionalStringValue(input, 'path')
          )

        case 'Grep':
          return await this.grepFiles(input)

        case 'GitStatus':
          return await this.gitCommand('git:status', { path: input?.path })

        case 'GitDiff':
          return await this.gitCommand('git:diff', {
            path: input?.path,
            staged: input?.staged,
            file: input?.file,
          })

        case 'GitLog':
          return await this.gitCommand('git:log', {
            path: input?.path,
            maxCount: input?.maxCount,
          })

        case 'GitCommit':
          return await this.gitCommand('git:commit', {
            path: input?.path,
            message: input?.message,
            files: input?.files,
          })

        case 'GitPush':
          return await this.gitCommand('git:push', {
            path: input?.path,
            remote: input?.remote,
            branch: input?.branch,
          })

        case 'GitCheckout':
          return await this.gitCommand('git:checkout', {
            path: input?.path,
            branch: input?.branch,
            create: input?.create,
          })

        case 'WebFetch':
          return await this.webFetch(
            this.getStringValue(input, 'url'),
            this.getOptionalNumberValue(input, 'maxLength')
          )

        case 'WebSearch':
          return await this.webSearch(input, options.webSearchEngine)

        default:
          throw new Error(`Unknown tool: ${toolName}`)
      }
    } catch (error: unknown) {
      return `Error: ${getBridgeErrorMessage(error) || 'Tool execution failed'}`
    }
  }

  private async readFile(path: string): Promise<string> {
    try {
      const response = await axios.post(`${IPC_BRIDGE_BASE}/ipc/fs:readFile`, {
        path,
      })
      return response.data.content
    } catch (error: unknown) {
      throw new Error(`Failed to read file: ${getBridgeErrorMessage(error)}`)
    }
  }

  private async writeFile(path: string, content: string): Promise<string> {
    try {
      const response = await axios.post(`${IPC_BRIDGE_BASE}/ipc/fs:writeFile`, {
        path,
        content,
      })

      if (response.data.success) {
        return `Successfully wrote ${content.length} characters to ${path}`
      } else {
        throw new Error('Write operation returned false')
      }
    } catch (error: unknown) {
      throw new Error(`Failed to write file: ${getBridgeErrorMessage(error)}`)
    }
  }

  private async editFile(
    path: string,
    oldText: string,
    newText: string,
    replaceAll?: boolean
  ): Promise<string> {
    try {
      const response = await axios.post(`${IPC_BRIDGE_BASE}/ipc/fs:editFile`, {
        path,
        oldText,
        newText,
        replaceAll,
      })

      const replaced = response.data.replaced
      return `Replaced ${replaced} occurrence${replaced === 1 ? '' : 's'} in ${path}`
    } catch (error: unknown) {
      throw new Error(`Failed to edit file: ${getBridgeErrorMessage(error)}`)
    }
  }

  private formatTodoList(input: Record<string, unknown>): string {
    const todos = Array.isArray(input.todos)
      ? (input.todos as TodoInput[])
      : null
    if (!todos) {
      throw new Error('Todos must be provided as an array')
    }

    const lines = todos.map(todo => {
      const marker = TODO_STATUS_MARKERS[todo.status]
      if (!marker) {
        throw new Error(`Invalid todo status: ${todo.status}`)
      }

      const title = todo.title ?? ''
      const mainLine = `- [${marker}] ${title}`
      const notes =
        typeof todo.notes === 'string' && todo.notes.trim().length > 0
          ? `\n  - ${todo.notes.trim()}`
          : ''
      return `${mainLine}${notes}`
    })

    return lines.join('\n')
  }

  private async globFiles(pattern: string, path?: string): Promise<string> {
    try {
      const response = await axios.post(`${IPC_BRIDGE_BASE}/ipc/fs:glob`, {
        pattern,
        path,
      })
      const files = response.data.files || []
      if (files.length === 0) {
        return 'No matches found.'
      }
      return files.join('\n')
    } catch (error: unknown) {
      throw new Error(`Failed to glob files: ${getBridgeErrorMessage(error)}`)
    }
  }

  private async grepFiles(input: Record<string, unknown>): Promise<string> {
    try {
      const response = await axios.post(`${IPC_BRIDGE_BASE}/ipc/fs:grep`, {
        pattern: input?.pattern,
        path: input?.path,
        glob: input?.glob,
        ignoreCase: input?.ignoreCase,
        maxResults: input?.maxResults,
      })
      const results = response.data.results || []
      if (results.length === 0) {
        return 'No matches found.'
      }
      return results
        .map(
          (result: GrepResult) =>
            `${result.file}:${result.line} ${result.content}`
        )
        .join('\n')
    } catch (error: unknown) {
      throw new Error(`Failed to grep files: ${getBridgeErrorMessage(error)}`)
    }
  }

  private async gitCommand(
    channel: string,
    payload: Record<string, unknown>
  ): Promise<string> {
    try {
      const response = await axios.post(
        `${IPC_BRIDGE_BASE}/ipc/${channel}`,
        payload
      )
      const output = response.data.output ?? ''
      const error = response.data.error
      if (error) {
        return output ? `${output}\n${error}` : error
      }
      return output
    } catch (error: unknown) {
      throw new Error(
        `Failed to run git command: ${getBridgeErrorMessage(error)}`
      )
    }
  }

  private async webFetch(url: string, maxLength?: number): Promise<string> {
    try {
      const response = await axios.post(`${IPC_BRIDGE_BASE}/ipc/web:fetch`, {
        url,
        maxLength,
      })
      return response.data.content
    } catch (error: unknown) {
      throw new Error(`Failed to fetch URL: ${getBridgeErrorMessage(error)}`)
    }
  }

  private getWebSearchEngine(
    input: Record<string, unknown>,
    defaultEngine?: 'google' | 'bing'
  ): 'google' | 'bing' | undefined {
    const value = this.getOptionalStringValue(input, 'engine')?.toLowerCase()
    if (value === 'google' || value === 'bing') return value
    return defaultEngine
  }

  private async webSearch(
    input: Record<string, unknown>,
    defaultEngine?: 'google' | 'bing'
  ): Promise<string> {
    try {
      const engine = this.getWebSearchEngine(input, defaultEngine)
      const response = await axios.post(`${IPC_BRIDGE_BASE}/ipc/web:search`, {
        query: input?.query,
        limit: input?.limit,
        recencyDays: input?.recencyDays,
        domains: input?.domains,
        engine,
      })
      const results = response.data.results || []
      if (results.length === 0) {
        return 'No results found.'
      }
      return results
        .map((result: WebSearchResult, index: number) => {
          const lines = [`${index + 1}. ${result.title}`]
          if (result.url) lines.push(`   ${result.url}`)
          if (result.snippet) lines.push(`   ${result.snippet}`)
          return lines.join('\n')
        })
        .join('\n')
    } catch (error: unknown) {
      throw new Error(`Failed to search web: ${getBridgeErrorMessage(error)}`)
    }
  }

  private async listFiles(path: string, pattern?: string): Promise<string> {
    try {
      const response = await axios.post(`${IPC_BRIDGE_BASE}/ipc/fs:listFiles`, {
        path,
        pattern,
      })

      const files = response.data.files
      if (files.length === 0) {
        return `Directory ${path} is empty or no files match the pattern`
      }

      const fileList = files
        .map((file: ListFileEntry) => {
          const type = file.isDirectory ? '[DIR]' : '[FILE]'
          const size = file.isDirectory ? '' : `(${this.formatSize(file.size)})`
          return `${type} ${file.name} ${size}`
        })
        .join('\n')

      return `Contents of ${path}:\n${fileList}`
    } catch (error: unknown) {
      throw new Error(`Failed to list files: ${getBridgeErrorMessage(error)}`)
    }
  }

  private async executeCommand(command: string, cwd?: string): Promise<string> {
    try {
      const response = await axios.post(`${IPC_BRIDGE_BASE}/ipc/exec:command`, {
        command,
        cwd,
      })

      const result = response.data
      let output = `Command: ${command}\n`

      if (result.output) {
        output += `\nOutput:\n${result.output}`
      }

      if (result.error) {
        output += `\nError/Warning:\n${result.error}`
      }

      return output
    } catch (error: unknown) {
      throw new Error(
        `Failed to execute command: ${getBridgeErrorMessage(error)}`
      )
    }
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }

  private getStringValue(input: Record<string, unknown>, key: string): string {
    const value = input[key]
    return typeof value === 'string' ? value : ''
  }

  private getOptionalStringValue(
    input: Record<string, unknown>,
    key: string
  ): string | undefined {
    const value = input[key]
    return typeof value === 'string' ? value : undefined
  }

  private getOptionalBooleanValue(
    input: Record<string, unknown>,
    key: string
  ): boolean | undefined {
    const value = input[key]
    return typeof value === 'boolean' ? value : undefined
  }

  private getOptionalNumberValue(
    input: Record<string, unknown>,
    key: string
  ): number | undefined {
    const value = input[key]
    return typeof value === 'number' ? value : undefined
  }
}
