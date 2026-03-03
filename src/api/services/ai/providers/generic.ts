import { BaseAIProvider } from './base'
import type {
  AIMessage,
  AIConfig,
  AIStreamChunk,
  AIRequestOptions,
} from '../../../../shared/types/ai'
import { getStrategy } from './strategies'
import { ToolExecutor } from '../tools/executor'

interface StreamToolCallBuffer {
  id: string
  name: string
  arguments: string
}

// Generic OpenAI-compatible provider for Moonshot, OpenRouter, and custom APIs
export class GenericProvider extends BaseAIProvider {
  readonly name = 'generic'
  readonly supportedModels: string[] = [] // Dynamic models

  getDefaultModel(): string {
    return '' // Must be specified in config
  }

  async sendMessage(
    messages: AIMessage[],
    config: AIConfig,
    onChunk?: (chunk: AIStreamChunk) => void,
    options?: AIRequestOptions
  ): Promise<string> {
    if (!config.baseURL) {
      throw new Error('Base URL is required for generic provider')
    }

    if (!config.apiKey || !config.model) {
      throw new Error('API Key and model are required')
    }

    try {
      if (onChunk) {
        return await this.streamResponseWithTools(
          messages,
          config,
          onChunk,
          options
        )
      } else {
        return await this.simpleResponseWithTools(messages, config, options)
      }
    } catch (error) {
      this.logError(error)
      throw error
    }
  }

  private async streamResponseWithTools(
    messages: AIMessage[],
    config: AIConfig,
    onChunk: (chunk: AIStreamChunk) => void,
    options?: AIRequestOptions
  ): Promise<string> {
    if (config.thinkingEnabled && config.apiFormat !== 'anthropic-messages') {
      console.warn(
        '[generic-provider] Thinking is enabled but apiFormat is not "anthropic-messages". ' +
          'Thinking only works with Anthropic Messages API format. ' +
          `Current apiFormat: "${config.apiFormat || 'chat-completions'}"`
      )
    }

    const toolExecutor = new ToolExecutor()
    const strategy = getStrategy(config.apiFormat)
    const conversationMessages = [...messages]
    let fullContent = ''
    let totalInputTokens = 0
    let totalOutputTokens = 0

    while (true) {
      const requestBody = strategy.buildBody(conversationMessages, config, {
        stream: true,
      })
      const headers = strategy.buildHeaders(config)

      const response = await fetch(
        `${config.baseURL}${strategy.getEndpoint(config)}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
        }
      )

      if (!response.ok) {
        const error = await response.text()
        throw new Error(`API error: ${response.status} - ${error}`)
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('Response body is not readable')
      }

      const decoder = new TextDecoder()
      let buffer = ''
      let currentContent = ''
      const toolCalls: StreamToolCallBuffer[] = []

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim()
              if (!data || data === '[DONE]') continue

              try {
                const parsed = JSON.parse(data)
                const result = strategy.parseStreamChunk(parsed)

                if (result?.content) {
                  currentContent += result.content
                  fullContent += result.content
                  onChunk({ content: result.content, done: false })
                }
                if (result?.thinking) {
                  onChunk({
                    content: '',
                    done: false,
                    thinking: result.thinking,
                  })
                }
                if (result?.toolCalls) {
                  for (const tc of result.toolCalls) {
                    const index = tc.index ?? toolCalls.length
                    if (!toolCalls[index]) {
                      toolCalls[index] = {
                        id: tc.id || '',
                        name: tc.function?.name || '',
                        arguments: tc.function?.arguments || '',
                      }
                    } else {
                      // Update existing entry
                      if (tc.id) toolCalls[index].id = tc.id
                      if (tc.function?.name)
                        toolCalls[index].name = tc.function.name
                      if (tc.function?.arguments)
                        toolCalls[index].arguments += tc.function.arguments
                    }
                  }
                }
                if (
                  parsed.type === 'message_start' &&
                  parsed.message?.usage?.input_tokens
                ) {
                  totalInputTokens += parsed.message.usage.input_tokens
                }
                if (parsed.type === 'message_delta' && parsed.usage) {
                  totalInputTokens += parsed.usage.input_tokens || 0
                  totalOutputTokens += parsed.usage.output_tokens || 0
                }
                if (parsed.usage) {
                  totalInputTokens += parsed.usage.prompt_tokens || 0
                  totalOutputTokens += parsed.usage.completion_tokens || 0
                }
              } catch (e) {
                console.error('Failed to parse chunk:', e)
              }
            }
          }
        }
      } finally {
        reader.releaseLock()
      }

      if (toolCalls.length === 0) {
        break
      }

      // Execute tools
      conversationMessages.push({
        role: 'assistant',
        content: currentContent || '',
      })

      for (const toolCall of toolCalls.filter(Boolean)) {
        const functionArgs = JSON.parse(toolCall.arguments || '{}')
        onChunk({
          content: '',
          done: false,
          toolCall: {
            id: toolCall.id,
            name: toolCall.name,
            input: functionArgs,
          },
        })

        const result = await toolExecutor.execute(toolCall.name, functionArgs, {
          toolCallId: toolCall.id,
          toolPermissions: options?.toolPermissions,
          allowOnceTools: options?.allowOnceTools,
          sessionApprovedTools: options?.sessionApprovedTools
            ? new Set(options.sessionApprovedTools)
            : undefined,
          permissionRules: options?.permissionRules,
          webSearchEngine: options?.webSearchEngine,
        })

        onChunk({
          content: '',
          done: false,
          toolResult: {
            toolCallId: toolCall.id,
            output: result,
            isError: false,
          },
        })

        conversationMessages.push({
          role: 'user',
          content: `Tool ${toolCall.name} result: ${result}`,
        })
      }
    }

    onChunk({
      content: '',
      done: true,
      usage:
        totalInputTokens > 0 || totalOutputTokens > 0
          ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
          : undefined,
    })
    return fullContent
  }

  private async simpleResponseWithTools(
    messages: AIMessage[],
    config: AIConfig,
    options?: AIRequestOptions
  ): Promise<string> {
    const toolExecutor = new ToolExecutor()
    const strategy = getStrategy(config.apiFormat)
    const conversationMessages = [...messages]
    let finalText = ''

    while (true) {
      const requestBody = strategy.buildBody(conversationMessages, config, {
        stream: false,
      })
      const headers = strategy.buildHeaders(config)

      const response = await fetch(
        `${config.baseURL}${strategy.getEndpoint(config)}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
        }
      )

      if (!response.ok) {
        const error = await response.text()
        throw new Error(`API error: ${response.status} - ${error}`)
      }

      const result = await response.json()
      const content = strategy.parseResponse(result)
      if (content) finalText += content

      const toolCalls = result.choices?.[0]?.message?.tool_calls
      if (!toolCalls || toolCalls.length === 0) {
        break
      }

      conversationMessages.push({ role: 'assistant', content: content || '' })

      for (const toolCall of toolCalls) {
        const functionArgs = JSON.parse(toolCall.function?.arguments || '{}')
        const toolResult = await toolExecutor.execute(
          toolCall.function?.name,
          functionArgs,
          {
            toolCallId: toolCall.id,
            toolPermissions: options?.toolPermissions,
            allowOnceTools: options?.allowOnceTools,
            sessionApprovedTools: options?.sessionApprovedTools
              ? new Set(options.sessionApprovedTools)
              : undefined,
            permissionRules: options?.permissionRules,
            webSearchEngine: options?.webSearchEngine,
          }
        )
        conversationMessages.push({
          role: 'user',
          content: `Tool ${toolCall.function?.name} result: ${toolResult}`,
        })
      }
    }

    return finalText
  }

  validateConfig(config: AIConfig): boolean {
    return !!(config.apiKey && config.model && config.baseURL)
  }
}
