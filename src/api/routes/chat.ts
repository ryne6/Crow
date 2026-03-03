import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { AIManager } from '../services/ai/manager'
import { ProviderValidator } from '../services/ai/validator'
import { AIError } from '../services/ai/errors'
import { MemoryExtractor } from '../services/memory/extractor'
import { ErrorCode } from '../../shared/types/error'
import type {
  AIMessage,
  AIConfig,
  AIStreamChunk,
  AIRequestOptions,
} from '../../shared/types/ai'
import type { PermissionRule } from '../../shared/types/toolPermissions'

const app = new Hono()
const aiManager = new AIManager()

/**
 * Helper to create error response from unknown errors
 */
function createErrorResponse(error: unknown): {
  error: ReturnType<AIError['toAPIError']>
} {
  const aiError = AIError.fromUnknown(error)
  return { error: aiError.toAPIError() }
}

interface ChatRequest {
  provider: string
  messages: AIMessage[]
  config: AIConfig
  toolPermissions?: AIRequestOptions['toolPermissions']
  allowOnceTools?: AIRequestOptions['allowOnceTools']
  // P1 新增
  permissionRules?: PermissionRule[]
  sessionApprovedTools?: string[]
  webSearchEngine?: AIRequestOptions['webSearchEngine']
}

interface ValidateRequest {
  provider: string
  config: AIConfig
}

// 发送消息（流式）
app.post('/chat/stream', async c => {
  try {
    const body = await c.req.json<ChatRequest>()
    const {
      provider,
      messages,
      config,
      toolPermissions,
      allowOnceTools,
      permissionRules,
      sessionApprovedTools,
      webSearchEngine,
    } = body

    // Validate required fields
    if (!provider || !messages || !config) {
      const error = new AIError(
        ErrorCode.INVALID_REQUEST,
        'Missing required fields: provider, messages, config'
      )
      return c.json(createErrorResponse(error), error.httpStatus)
    }

    return stream(c, async stream => {
      try {
        await aiManager.sendMessage(
          provider,
          messages,
          config,
          async (chunk: AIStreamChunk) => {
            await stream.write(JSON.stringify(chunk) + '\n')
          },
          {
            toolPermissions,
            allowOnceTools,
            permissionRules,
            sessionApprovedTools,
            webSearchEngine,
          }
        )
      } catch (error) {
        const aiError = AIError.fromUnknown(error)
        await stream.write(
          JSON.stringify({ error: aiError.toAPIError() }) + '\n'
        )
      }
    })
  } catch (error) {
    const aiError = AIError.fromUnknown(error)
    return c.json(createErrorResponse(aiError), aiError.httpStatus)
  }
})

// 发送消息（非流式）
app.post('/chat', async c => {
  try {
    const body = await c.req.json<ChatRequest>()
    const {
      provider,
      messages,
      config,
      toolPermissions,
      allowOnceTools,
      permissionRules,
      sessionApprovedTools,
      webSearchEngine,
    } = body

    // Validate required fields
    if (!provider || !messages || !config) {
      const error = new AIError(
        ErrorCode.INVALID_REQUEST,
        'Missing required fields: provider, messages, config'
      )
      return c.json(createErrorResponse(error), error.httpStatus)
    }

    const response = await aiManager.sendMessage(
      provider,
      messages,
      config,
      undefined,
      {
        toolPermissions,
        allowOnceTools,
        permissionRules,
        sessionApprovedTools,
        webSearchEngine,
      }
    )

    return c.json({
      content: response,
    })
  } catch (error) {
    const aiError = AIError.fromUnknown(error)
    return c.json(createErrorResponse(aiError), aiError.httpStatus)
  }
})

// 获取支持的 AI 提供商列表
app.get('/providers', c => {
  try {
    const providers = aiManager.getAvailableProviders()
    return c.json({ providers })
  } catch (error) {
    const aiError = AIError.fromUnknown(error)
    return c.json(createErrorResponse(aiError), aiError.httpStatus)
  }
})

// 获取指定提供商的默认模型
app.get('/providers/:provider/default-model', c => {
  try {
    const provider = c.req.param('provider')
    const defaultModel = aiManager.getDefaultModel(provider)
    return c.json({ defaultModel })
  } catch (error) {
    const aiError = AIError.fromUnknown(error)
    return c.json(createErrorResponse(aiError), aiError.httpStatus)
  }
})

// 获取指定提供商支持的模型列表
app.get('/providers/:provider/models', c => {
  try {
    const provider = c.req.param('provider')
    const models = aiManager.getSupportedModels(provider)
    return c.json({ models })
  } catch (error) {
    const aiError = AIError.fromUnknown(error)
    return c.json(createErrorResponse(aiError), aiError.httpStatus)
  }
})

// 验证 Provider 配置
app.post('/providers/validate', async c => {
  try {
    const body = await c.req.json<ValidateRequest>()
    const { provider, config } = body

    if (!provider || !config) {
      const error = new AIError(
        ErrorCode.INVALID_REQUEST,
        'Missing required fields: provider, config'
      )
      return c.json(
        { valid: false, error: error.toAPIError() },
        error.httpStatus
      )
    }

    const result = await ProviderValidator.validateProvider(provider, config)

    return c.json(result)
  } catch (error) {
    const aiError = AIError.fromUnknown(error)
    return c.json(
      {
        valid: false,
        error: aiError.toAPIError(),
      },
      aiError.httpStatus
    )
  }
})

// 从对话中提取记忆
app.post('/chat/extract', async c => {
  try {
    const { provider, messages, config } = await c.req.json<{
      provider: string
      messages: AIMessage[]
      config: AIConfig
    }>()

    if (!provider || !messages || !config) {
      const error = new AIError(
        ErrorCode.INVALID_REQUEST,
        'Missing required fields: provider, messages, config'
      )
      return c.json(createErrorResponse(error), error.httpStatus)
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ memories: [] })
    }
    if (messages.length > 50) {
      return c.json({ memories: [] })
    }

    const memories = await MemoryExtractor.extract(messages, provider, config)
    return c.json({ memories })
  } catch (error) {
    const aiError = AIError.fromUnknown(error)
    return c.json(createErrorResponse(aiError), aiError.httpStatus)
  }
})

// 压缩 system prompt
const COMPRESSION_SYSTEM_PROMPT = `你是一个对话摘要助手。请将以下对话历史压缩为简洁的摘要。

要求：
- 保留所有文件路径、代码片段、技术决策
- 保留错误信息和解决方案
- 保留因果关系和上下文依赖
- 500 字以内
- 使用与原始对话相同的语言
- 以 "[Context Summary]" 开头`

// 上下文压缩端点（非流式，独立超时）
app.post('/chat/compress', async c => {
  try {
    const { provider, messages, config } = await c.req.json<{
      provider: string
      messages: AIMessage[]
      config: AIConfig
    }>()

    if (!provider || !messages || !config) {
      const error = new AIError(
        ErrorCode.INVALID_REQUEST,
        'Missing required fields: provider, messages, config'
      )
      return c.json(createErrorResponse(error), error.httpStatus)
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ summary: '' })
    }

    // 构建压缩请求：system prompt + 待压缩消息
    const compressMessages: AIMessage[] = [
      { role: 'system', content: COMPRESSION_SYSTEM_PROMPT },
      ...messages,
      {
        role: 'user',
        content: '请将以上对话压缩为摘要。',
      },
    ]

    // 非流式调用，低温度
    const compressConfig: AIConfig = {
      ...config,
      temperature: 0.2,
      maxTokens: 2048,
      thinkingEnabled: false,
    }

    const response = await aiManager.sendMessage(
      provider,
      compressMessages,
      compressConfig
    )

    return c.json({ summary: response || '' })
  } catch (error) {
    const aiError = AIError.fromUnknown(error)
    return c.json(createErrorResponse(aiError), aiError.httpStatus)
  }
})

export default app
