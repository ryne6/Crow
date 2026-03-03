import type {
  AIMessage,
  AIConfig,
  AIStreamChunk,
  AIRequestOptions,
} from '~shared/types/ai'
import type { APIError } from '~shared/types/error'
import { ErrorCode } from '~shared/types/error'

// Dynamic API base URL - will be set on initialization
let API_BASE_URL = 'http://localhost:2323/api'
let apiPort: number | null = null

// Initialize API client with dynamic port
export async function initApiClient(): Promise<void> {
  try {
    const port = await window.api.api.getPort()
    if (port) {
      apiPort = port
      API_BASE_URL = `http://localhost:${port}/api`
      console.log(`📡 API client initialized with port ${port}`)
    }
  } catch (error) {
    console.error('Failed to get API port, using default:', error)
  }
}

export function getApiBaseUrl(): string {
  return API_BASE_URL
}

// Retry configuration
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_DELAY = 1000 // 1 second
const RETRYABLE_STATUS_CODES = [429, 503, 408, 504]

interface RetryOptions {
  maxRetries?: number
  baseDelay?: number
  retryableCodes?: number[]
}

/**
 * Custom error class for API client errors
 */
export class APIClientError extends Error {
  readonly apiError?: APIError
  readonly status?: number

  constructor(message: string, apiError?: APIError, status?: number) {
    super(message)
    this.name = 'APIClientError'
    this.apiError = apiError
    this.status = status
  }

  get retryable(): boolean {
    return this.apiError?.retryable ?? false
  }

  get retryAfter(): number | undefined {
    return this.apiError?.retryAfter
  }

  get code(): ErrorCode | undefined {
    return this.apiError?.code
  }
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateBackoff(attempt: number, baseDelay: number): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt)
  const jitter = Math.random() * 0.3 * exponentialDelay
  return Math.min(exponentialDelay + jitter, 30000) // Cap at 30 seconds
}

/**
 * Parse error response from API
 */
async function parseErrorResponse(response: Response): Promise<APIClientError> {
  try {
    const data = await response.json()
    if (data.error && typeof data.error === 'object') {
      return new APIClientError(
        data.error.message || `HTTP error: ${response.status}`,
        data.error as APIError,
        response.status
      )
    }
    return new APIClientError(
      data.error || `HTTP error: ${response.status}`,
      undefined,
      response.status
    )
  } catch {
    return new APIClientError(
      `HTTP error: ${response.status}`,
      undefined,
      response.status
    )
  }
}

export class APIClient {
  /**
   * Fetch with exponential backoff retry for retryable errors
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retryOptions: RetryOptions = {}
  ): Promise<Response> {
    const {
      maxRetries = DEFAULT_MAX_RETRIES,
      baseDelay = DEFAULT_BASE_DELAY,
      retryableCodes = RETRYABLE_STATUS_CODES,
    } = retryOptions

    let lastError: APIClientError | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, options)

        if (response.ok) {
          return response
        }

        const error = await parseErrorResponse(response)

        // Check if we should retry
        const shouldRetry =
          attempt < maxRetries &&
          (retryableCodes.includes(response.status) || error.retryable)

        if (!shouldRetry) {
          throw error
        }

        lastError = error

        // Calculate delay (use retryAfter if provided)
        const delay = error.retryAfter
          ? error.retryAfter * 1000
          : calculateBackoff(attempt, baseDelay)

        await sleep(delay)
      } catch (error) {
        if (error instanceof APIClientError) {
          throw error
        }

        // Network errors are retryable
        if (attempt < maxRetries) {
          lastError = new APIClientError(
            error instanceof Error ? error.message : 'Network error'
          )
          await sleep(calculateBackoff(attempt, baseDelay))
          continue
        }

        throw new APIClientError(
          error instanceof Error ? error.message : 'Network error'
        )
      }
    }

    throw lastError || new APIClientError('Max retries exceeded')
  }

  /**
   * 发送消息（流式）
   */
  async sendMessageStream(
    provider: string,
    messages: AIMessage[],
    config: AIConfig,
    onChunk: (chunk: AIStreamChunk) => void,
    signal?: AbortSignal,
    options?: AIRequestOptions
  ): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider,
        messages,
        config,
        toolPermissions: options?.toolPermissions,
        allowOnceTools: options?.allowOnceTools,
        permissionRules: options?.permissionRules,
        sessionApprovedTools: options?.sessionApprovedTools,
        webSearchEngine: options?.webSearchEngine,
      }),
      signal,
    })

    if (!response.ok) {
      throw await parseErrorResponse(response)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new APIClientError('Failed to get response reader')
    }

    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.trim()) {
            try {
              const chunk = JSON.parse(line) as
                | AIStreamChunk
                | { error: APIError | string }
              if ('error' in chunk) {
                // Handle structured error response
                const errorData = chunk.error
                if (typeof errorData === 'object' && errorData !== null) {
                  throw new APIClientError(errorData.message, errorData)
                }
                throw new APIClientError(String(errorData))
              }
              onChunk(chunk)
            } catch (error) {
              if (error instanceof APIClientError) {
                throw error
              }
              // Re-throw parse errors as APIClientError
              throw new APIClientError(
                error instanceof Error
                  ? error.message
                  : 'Failed to parse response'
              )
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * 发送消息（非流式）
   */
  async sendMessage(
    provider: string,
    messages: AIMessage[],
    config: AIConfig,
    options?: AIRequestOptions
  ): Promise<string> {
    const response = await this.fetchWithRetry(`${API_BASE_URL}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider,
        messages,
        config,
        toolPermissions: options?.toolPermissions,
        allowOnceTools: options?.allowOnceTools,
        permissionRules: options?.permissionRules,
        sessionApprovedTools: options?.sessionApprovedTools,
        webSearchEngine: options?.webSearchEngine,
      }),
    })

    const data = await response.json()
    return data.content
  }

  /**
   * 获取可用的 AI 提供商列表
   */
  async getAvailableProviders(): Promise<string[]> {
    const response = await this.fetchWithRetry(`${API_BASE_URL}/providers`, {})
    const data = await response.json()
    return data.providers
  }

  /**
   * 获取指定提供商的默认模型
   */
  async getDefaultModel(provider: string): Promise<string> {
    const response = await this.fetchWithRetry(
      `${API_BASE_URL}/providers/${provider}/default-model`,
      {}
    )
    const data = await response.json()
    return data.defaultModel
  }

  /**
   * 获取指定提供商支持的模型列表
   */
  async getSupportedModels(provider: string): Promise<string[]> {
    const response = await this.fetchWithRetry(
      `${API_BASE_URL}/providers/${provider}/models`,
      {}
    )
    const data = await response.json()
    return data.models
  }

  /**
   * 上下文压缩（非流式，30s 超时）
   */
  async compressMessages(
    provider: string,
    messages: AIMessage[],
    config: AIConfig
  ): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    try {
      const response = await fetch(`${API_BASE_URL}/chat/compress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, messages, config }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw await parseErrorResponse(response)
      }

      const data = await response.json()
      return data.summary || ''
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<boolean> {
    try {
      const port = apiPort || 2323
      const response = await fetch(`http://localhost:${port}/health`)
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * 验证 Provider 配置
   */
  async validateProvider(
    provider: string,
    config: AIConfig
  ): Promise<{ valid: boolean; error?: string; apiError?: APIError }> {
    try {
      const response = await this.fetchWithRetry(
        `${API_BASE_URL}/providers/validate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ provider, config }),
        }
      )

      const result = await response.json()
      return result
    } catch (error) {
      if (error instanceof APIClientError) {
        return {
          valid: false,
          error: error.message,
          apiError: error.apiError,
        }
      }
      return {
        valid: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to validate provider',
      }
    }
  }
}

export const apiClient = new APIClient()
