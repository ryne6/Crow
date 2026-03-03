import Anthropic from '@anthropic-ai/sdk'
import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MessageParam as AnthropicMessageParam,
  RawMessageStreamEvent,
  ToolResultBlockParam,
  ToolUseBlock,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
import { BaseAIProvider } from './base'
import type {
  AIMessage,
  AIConfig,
  AIStreamChunk,
  MessageContent,
  AIRequestOptions,
} from '../../../../shared/types/ai'
import { getAllTools } from '../tools/definitions'
import { ToolExecutor } from '../tools/executor'

interface ToolUseAccumulator {
  id: string
  name: string
  input: Record<string, unknown>
  inputJson?: string
}

type AnthropicImageMimeType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'

export class ClaudeProvider extends BaseAIProvider {
  readonly name = 'claude'
  readonly supportsVision = true
  readonly supportsThinking = true
  readonly supportedModels = [
    'claude-sonnet-4-20250514',
    'claude-opus-4-5-20251101',
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-20241022',
    'claude-3-opus-20240229',
    'claude-3-sonnet-20240229',
    'claude-3-haiku-20240307',
  ]

  /**
   * Convert AIMessage content to Claude API format
   */
  private convertContent(
    content: string | MessageContent[]
  ): string | ContentBlockParam[] {
    if (typeof content === 'string') {
      return content
    }

    const blocks: ContentBlockParam[] = []
    for (const block of content) {
      if (block.type === 'text') {
        blocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        const mimeType = this.toAnthropicImageMimeType(block.mimeType)
        if (!mimeType) {
          continue
        }
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType,
            data: block.data,
          },
        })
      }
    }

    return blocks
  }

  private toAnthropicImageMimeType(
    mimeType: string
  ): AnthropicImageMimeType | null {
    return mimeType === 'image/jpeg' ||
      mimeType === 'image/png' ||
      mimeType === 'image/gif' ||
      mimeType === 'image/webp'
      ? mimeType
      : null
  }

  private extractSystemText(content: AIMessage['content']): string {
    if (typeof content === 'string') return content
    return content
      .filter((block): block is Extract<MessageContent, { type: 'text' }> =>
        block.type === 'text'
      )
      .map(block => block.text)
      .join('\n')
  }

  private parseToolInput(raw: string | undefined): Record<string, unknown> {
    if (!raw) return {}
    try {
      const parsed: unknown = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }

  async sendMessage(
    messages: AIMessage[],
    config: AIConfig,
    onChunk?: (chunk: AIStreamChunk) => void,
    options?: AIRequestOptions
  ): Promise<string> {
    if (!this.validateConfig(config)) {
      throw new Error('Invalid configuration')
    }

    const client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    })

    try {
      if (onChunk) {
        return await this.streamResponseWithTools(
          client,
          messages,
          config,
          onChunk,
          options
        )
      } else {
        return await this.simpleResponseWithTools(
          client,
          messages,
          config,
          options
        )
      }
    } catch (error) {
      this.logError(error)
      throw error
    }
  }

  private async streamResponseWithTools(
    client: Anthropic,
    messages: AIMessage[],
    config: AIConfig,
    onChunk: (chunk: AIStreamChunk) => void,
    options?: AIRequestOptions
  ): Promise<string> {
    let fullContent = ''
    const toolExecutor = new ToolExecutor()
    let totalInputTokens = 0
    let totalOutputTokens = 0

    // Extract system message and conversation messages
    const systemMessage = messages.find(m => m.role === 'system')
    const conversationMessages: AnthropicMessageParam[] = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: this.convertContent(m.content),
      }))

    while (true) {
      // Build request parameters
      const requestParams: MessageCreateParamsStreaming = {
        model: config.model,
        max_tokens: config.maxTokens || 10000000,
        messages: conversationMessages,
        tools: getAllTools() as MessageCreateParamsStreaming['tools'],
        stream: true,
      }

      // Add system prompt if present
      if (systemMessage) {
        requestParams.system = this.extractSystemText(systemMessage.content)
      }

      // Add thinking configuration if enabled
      if (config.thinkingEnabled) {
        requestParams.thinking = {
          type: 'enabled',
          budget_tokens: 10000,
        }
        // Temperature MUST be 1 when thinking is enabled
        requestParams.temperature = 1
      } else {
        requestParams.temperature = config.temperature || 1
      }

      const stream = (await client.messages.create(
        requestParams
      )) as AsyncIterable<RawMessageStreamEvent>
      console.log(
        '[Claude] Request with thinking:',
        config.thinkingEnabled,
        'params:',
        JSON.stringify(requestParams.thinking)
      )

      let currentContent = ''
      const toolUses: ToolUseAccumulator[] = []

      for await (const chunk of stream) {
        console.log(
          '[Claude] Chunk:',
          chunk.type,
          chunk.type === 'content_block_delta' ? chunk.delta.type : undefined
        )
        if (chunk.type === 'content_block_start') {
          console.log('[Claude] Block start:', chunk.content_block.type)
          if (chunk.content_block.type === 'tool_use') {
            toolUses.push({
              id: chunk.content_block.id,
              name: chunk.content_block.name,
              input: {},
            })
          }
        } else if (chunk.type === 'content_block_delta') {
          if (chunk.delta.type === 'thinking_delta') {
            // Stream thinking content
            onChunk({
              content: '',
              done: false,
              thinking: chunk.delta.thinking,
            })
          } else if (chunk.delta.type === 'text_delta') {
            currentContent += chunk.delta.text
            fullContent += chunk.delta.text
            onChunk({ content: chunk.delta.text, done: false })
          } else if (chunk.delta.type === 'input_json_delta') {
            // Accumulate tool input
            const lastTool = toolUses[toolUses.length - 1]
            if (lastTool) {
              lastTool.inputJson =
                (lastTool.inputJson || '') + chunk.delta.partial_json
            }
          }
        } else if (chunk.type === 'message_start') {
          totalInputTokens += chunk.message.usage.input_tokens || 0
        } else if (chunk.type === 'message_delta') {
          totalOutputTokens += chunk.usage.output_tokens || 0
        } else if (chunk.type === 'message_stop') {
          // Parse tool inputs
          for (const tool of toolUses) {
            if (tool.inputJson) {
              tool.input = this.parseToolInput(tool.inputJson)
            }
          }
        }
      }

      // If no tools were called, we're done
      if (toolUses.length === 0) {
        break
      }

      // Execute tools and continue conversation
      const toolResults: ToolResultBlockParam[] = []
      for (const toolUse of toolUses) {
        // Send tool call info
        onChunk({
          content: '',
          done: false,
          toolCall: {
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
          },
        })

        const result = await toolExecutor.execute(toolUse.name, toolUse.input, {
          toolCallId: toolUse.id,
          toolPermissions: options?.toolPermissions,
          allowOnceTools: options?.allowOnceTools,
          sessionApprovedTools: options?.sessionApprovedTools
            ? new Set(options.sessionApprovedTools)
            : undefined,
          permissionRules: options?.permissionRules,
          webSearchEngine: options?.webSearchEngine,
        })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        })

        // Send tool result info
        onChunk({
          content: '',
          done: false,
          toolResult: {
            toolCallId: toolUse.id,
            output: result,
            isError: false,
          },
        })
      }

      // Add assistant message with tool uses and user message with tool results
      conversationMessages.push({
        role: 'assistant',
        content: toolUses.map<ToolUseBlockParam>(t => ({
          type: 'tool_use',
          id: t.id,
          name: t.name,
          input: t.input,
        })),
      })

      conversationMessages.push({
        role: 'user',
        content: toolResults,
      })
    }

    onChunk({
      content: '',
      done: true,
      usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    })
    return fullContent
  }

  private async simpleResponseWithTools(
    client: Anthropic,
    messages: AIMessage[],
    config: AIConfig,
    options?: AIRequestOptions
  ): Promise<string> {
    const toolExecutor = new ToolExecutor()

    // Extract system message and conversation messages
    const systemMessage = messages.find(m => m.role === 'system')
    const conversationMessages: AnthropicMessageParam[] = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: this.convertContent(m.content),
      }))

    let finalText = ''

    while (true) {
      // Build request parameters
      const requestParams: MessageCreateParamsNonStreaming = {
        model: config.model,
        max_tokens: config.maxTokens || 10000000,
        messages: conversationMessages,
        tools: getAllTools() as MessageCreateParamsNonStreaming['tools'],
      }

      // Add system prompt if present
      if (systemMessage) {
        requestParams.system = this.extractSystemText(systemMessage.content)
      }

      // Add thinking configuration if enabled
      if (config.thinkingEnabled) {
        requestParams.thinking = {
          type: 'enabled',
          budget_tokens: 10000,
        }
        requestParams.temperature = 1
      } else {
        requestParams.temperature = config.temperature || 1
      }

      const response = await client.messages.create(requestParams)

      // Extract text content
      const textContent = response.content.filter(
        block => block.type === 'text'
      )
      for (const block of textContent) {
        if (block.type === 'text') {
          finalText += block.text
        }
      }

      // Check for tool uses
      const toolUses = response.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use'
      )

      if (toolUses.length === 0) {
        break
      }

      // Execute tools
      const toolResults: ToolResultBlockParam[] = []
      for (const toolUse of toolUses) {
        const toolInput =
          toolUse.input &&
          typeof toolUse.input === 'object' &&
          !Array.isArray(toolUse.input)
            ? (toolUse.input as Record<string, unknown>)
            : {}
        const result = await toolExecutor.execute(
          toolUse.name,
          toolInput,
          {
            toolCallId: toolUse.id,
            toolPermissions: options?.toolPermissions,
            allowOnceTools: options?.allowOnceTools,
            sessionApprovedTools: options?.sessionApprovedTools
              ? new Set(options.sessionApprovedTools)
              : undefined,
            permissionRules: options?.permissionRules,
            webSearchEngine: options?.webSearchEngine,
          }
        )
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        })
      }

      // Continue conversation
      conversationMessages.push({
        role: 'assistant',
        content: response.content as unknown as AnthropicMessageParam['content'],
      })

      conversationMessages.push({
        role: 'user',
        content: toolResults,
      })
    }

    return finalText
  }

  getDefaultModel(): string {
    return 'claude-3-5-sonnet-20241022'
  }
}
