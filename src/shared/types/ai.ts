import type { ToolPermissionState, PermissionRule } from './toolPermissions'

/**
 * Text content block
 */
export interface TextContent {
  type: 'text'
  text: string
}

/**
 * Image content block
 */
export interface ImageContent {
  type: 'image'
  mimeType: string
  data: string // base64 encoded
  note?: string
}

/**
 * Multimodal content (text and/or images)
 */
export type MessageContent = TextContent | ImageContent

/**
 * AI message with support for multimodal content
 */
export interface AIMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | MessageContent[]
}

/**
 * Helper to check if content is multimodal
 */
export function isMultimodalContent(
  content: string | MessageContent[]
): content is MessageContent[] {
  return Array.isArray(content)
}

/**
 * Helper to extract text from content
 */
export function getTextContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') {
    return content
  }
  return content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text)
    .join('')
}

export interface ToolCallData {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultData {
  toolCallId: string
  output: string
  isError?: boolean
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface AIStreamChunk {
  content: string
  done: boolean
  toolCall?: ToolCallData
  toolResult?: ToolResultData
  thinking?: string
  usage?: TokenUsage
  durationMs?: number
}

export interface AIConfig {
  providerId?: string
  authType?: 'api_key' | 'oauth'
  oauthProvider?: string
  apiKey: string
  model: string
  baseURL?: string
  apiFormat?: string
  temperature?: number
  maxTokens?: number
  thinkingEnabled?: boolean
  thinkingBudget?: number
}

export interface AIRequestOptions {
  toolPermissions?: ToolPermissionState
  allowOnceTools?: string[]
  // P1 新增
  permissionRules?: PermissionRule[]
  sessionApprovedTools?: string[] // 序列化为数组传输
}

export interface AIProvider {
  readonly name: string
  readonly supportedModels: string[]

  sendMessage(
    messages: AIMessage[],
    config: AIConfig,
    onChunk?: (chunk: AIStreamChunk) => void,
    options?: AIRequestOptions
  ): Promise<string>

  validateConfig(config: AIConfig): boolean
  getDefaultModel(): string
}
