import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import { apiClient, APIClientError } from '../services/apiClient'
import { dbClient } from '../services/dbClient'
import type {
  AIMessage,
  AIConfig,
  AIStreamChunk,
  MessageContent,
  AIRequestOptions,
} from '~shared/types/ai'
import type { APIError } from '~shared/types/error'
import { ErrorCode, getErrorMessage } from '~shared/types/error'
import type { Message, ToolCall, ToolResult } from '~shared/types/conversation'
import type { PendingAttachment } from '~shared/types/attachment'
import type { ApprovalScope } from '~shared/types/toolPermissions'
import { useConversationStore } from './conversationStore'
import { useSettingsStore } from './settingsStore'

// TODO: Consider extracting memory-related logic into a dedicated memoryStore.ts

/**
 * P1: Fire-and-forget memory extraction.
 * Gathers recent messages from the conversation and calls the extraction pipeline.
 * C1 fix: Only passes providerId + modelId — main process resolves credentials from DB.
 */
async function triggerMemoryExtraction(
  conversationId: string,
  providerId: string,
  modelId: string
): Promise<void> {
  const conv = useConversationStore
    .getState()
    .conversations.find(c => c.id === conversationId)
  if (!conv || conv.messages.length === 0) return

  const workspacePath = useConversationStore.getState().getEffectiveWorkspace()

  // Build lightweight message array for extraction (last 10, text only)
  const recentMessages = conv.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-10)
    .map(m => ({
      role: m.role,
      content: m.content,
    }))

  const result = await window.api.memory.extract({
    messages: recentMessages,
    providerId,
    modelId,
    workspacePath: workspacePath || undefined,
    conversationId,
  })

  if (result.saved > 0) {
    console.warn(
      `Auto-extracted ${result.extracted} memories, ${result.saved} new saved`
    )
  }
}

/** Export for use by conversationStore on conversation switch */
export { triggerMemoryExtraction }

function hasConfiguredProviderCredentials(provider: {
  type: string
  apiKey?: string
  authType?: 'api_key' | 'oauth'
}): boolean {
  if (provider.type === 'openai' && provider.authType === 'oauth') {
    return true
  }
  return Boolean(provider.apiKey && provider.apiKey.trim().length > 0)
}

async function buildAIConfig(
  provider: {
    id: string
    type: string
    baseURL?: string | null
    apiFormat?: string | null
  },
  model: { modelId: string },
  settingsState: { temperature: number; thinkingEnabled: boolean }
): Promise<AIConfig> {
  const resolvedCredentials = await dbClient.providers.resolveCredentials(
    provider.id
  )
  return {
    providerId: provider.id,
    authType: resolvedCredentials.authType,
    oauthProvider: resolvedCredentials.oauthProvider || undefined,
    apiKey: resolvedCredentials.apiKey,
    model: model.modelId,
    baseURL: provider.baseURL || undefined,
    apiFormat: provider.apiFormat || 'chat-completions',
    temperature: settingsState.temperature,
    maxTokens: 4096,
    thinkingEnabled: settingsState.thinkingEnabled,
  }
}

// 上下文压缩常量
const COMPRESSION_THRESHOLD = 0.8
const KEEP_RECENT = 6

// 截断降级：AI 压缩失败时的 fallback
function generateTruncatedSummary(msgs: Message[]): string {
  const lines = msgs.map(m => {
    const prefix = m.role === 'user' ? 'User' : 'Assistant'
    const text = m.content.slice(0, 100)
    return `${prefix}: ${text}${m.content.length > 100 ? '...' : ''}`
  })
  return `[Truncated Summary]\n${lines.join('\n')}`
}

// 手动触发压缩（/compact 命令调用）
export async function triggerCompression(
  conversationId: string,
  providerType: string,
  config: AIConfig
): Promise<{ compressed: boolean; count: number }> {
  const conv = useConversationStore
    .getState()
    .conversations.find(c => c.id === conversationId)
  if (!conv) return { compressed: false, count: 0 }

  const activeMessages = conv.messages.filter(m => !m.compressed)
  if (activeMessages.length <= KEEP_RECENT + 1) {
    return { compressed: false, count: 0 }
  }

  const toCompress = activeMessages.slice(0, -KEEP_RECENT)
  const toCompressIds = toCompress.map(m => m.id)

  const compressPayload: AIMessage[] = toCompress.map(m => ({
    role: m.role as 'user' | 'assistant',
    content:
      m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content,
  }))

  let summaryContent: string
  try {
    summaryContent = await apiClient.compressMessages(
      providerType,
      compressPayload,
      config
    )
  } catch (err) {
    console.error('AI compression failed, falling back to truncation:', err)
    summaryContent = generateTruncatedSummary(toCompress)
  }

  const summaryId = uuidv4()
  await window.api.ipc.invoke('db:messages:createSummary', {
    id: summaryId,
    conversationId,
    content: summaryContent,
    summaryOf: toCompressIds,
    timestamp: Date.now(),
  })

  await window.api.ipc.invoke('db:messages:markCompressed', {
    messageIds: toCompressIds,
  })

  const summaryMessage: Message = {
    id: summaryId,
    role: 'assistant',
    content: summaryContent,
    timestamp: Date.now(),
    summaryOf: toCompressIds,
    inputTokens: toCompress.reduce((s, m) => s + (m.inputTokens ?? 0), 0),
    outputTokens: toCompress.reduce((s, m) => s + (m.outputTokens ?? 0), 0),
  }

  const updatedMessages = [
    summaryMessage,
    ...conv.messages.filter(m => !toCompressIds.includes(m.id)),
  ]

  useConversationStore.getState().updateConversation(conversationId, {
    messages: updatedMessages,
  })

  return { compressed: true, count: toCompressIds.length }
}

// 缓冲区消息项
export interface BufferItem {
  id: string
  content: string
  attachments?: PendingAttachment[]
  createdAt: number
}

// VList 滚动方法接口
interface ScrollMethods {
  scrollToIndex: (
    index: number,
    options?: { align?: string; smooth?: boolean }
  ) => void
  scrollToEnd: () => void
}

interface ChatStore {
  // State
  isLoading: boolean
  abortController: AbortController | null
  error: string | null
  lastError: APIError | null
  retryable: boolean
  // P0 新增：session 级已授权工具
  // key = conversationId, value = 已授权的工具名集合
  sessionApprovals: Record<string, string[]>
  // 滚动状态
  atBottom: boolean
  isScrolling: boolean
  // 消息缓冲队列
  messageBuffer: BufferItem[]

  // Actions
  sendMessage: (
    conversationId: string,
    content: string,
    providerType: string,
    config: AIConfig,
    attachments?: PendingAttachment[],
    options?: AIRequestOptions
  ) => Promise<void>
  approveToolCall: (
    conversationId: string,
    toolName: string,
    scope: ApprovalScope
  ) => Promise<void>
  denyToolCall: (
    conversationId: string,
    toolName: string,
    toolCallId: string,
    reason?: string
  ) => Promise<void>
  getSessionApprovedTools: (conversationId: string) => string[]
  enqueueMessage: (
    content: string,
    attachments?: BufferItem['attachments']
  ) => boolean
  dequeueMessage: (id: string) => void
  clearBuffer: () => void
  sendBufferItem: (id: string) => void
  abortMessage: () => void
  clearError: () => void
  setScrollState: (
    state: Partial<{ atBottom: boolean; isScrolling: boolean }>
  ) => void
  scrollToBottom: (smooth?: boolean) => void
  scrollToIndex: (index: number) => void
  registerScrollMethods: (methods: ScrollMethods | null) => void
}

// 滚动方法引用，由 MessageList 注册
let _scrollMethods: ScrollMethods | null = null

export const useChatStore = create<ChatStore>((set, get) => ({
  // State
  isLoading: false,
  abortController: null,
  error: null,
  lastError: null,
  retryable: false,
  sessionApprovals: {},
  atBottom: true,
  isScrolling: false,
  messageBuffer: [],

  // Actions
  clearError: () => set({ error: null, lastError: null, retryable: false }),

  setScrollState: scrollState => set(scrollState),

  scrollToBottom: (smooth = false) => {
    if (!_scrollMethods) return
    if (smooth) {
      const conv = useConversationStore
        .getState()
        .conversations.find(
          c => c.id === useConversationStore.getState().currentConversationId
        )
      const len = conv?.messages.length ?? 0
      if (len > 0) {
        _scrollMethods.scrollToIndex(len - 1, { align: 'end', smooth: true })
      }
    } else {
      _scrollMethods.scrollToEnd()
    }
  },

  scrollToIndex: (index: number) => {
    if (!_scrollMethods) return
    _scrollMethods.scrollToIndex(index, { align: 'center', smooth: true })
  },

  registerScrollMethods: methods => {
    _scrollMethods = methods
  },

  // 入队消息到缓冲区，最多 5 条
  enqueueMessage: (content, attachments) => {
    const { messageBuffer } = get()
    if (messageBuffer.length >= 5) return false
    const item: BufferItem = {
      id: crypto.randomUUID(),
      content,
      attachments,
      createdAt: Date.now(),
    }
    set({ messageBuffer: [...messageBuffer, item] })
    return true
  },

  // 从缓冲区移除指定消息
  dequeueMessage: (id) => {
    set({ messageBuffer: get().messageBuffer.filter(m => m.id !== id) })
  },

  // 清空缓冲区
  clearBuffer: () => {
    set({ messageBuffer: [] })
  },

  // 立即发送缓冲区中的指定消息（中断当前生成）
  sendBufferItem: (id) => {
    const { messageBuffer } = get()
    const item = messageBuffer.find(m => m.id === id)
    if (!item) return

    // 中断当前生成
    get().abortMessage()

    // 从缓冲区移除
    set({ messageBuffer: messageBuffer.filter(m => m.id !== id) })

    // 删除当前 assistant 占位消息
    const convStore = useConversationStore.getState()
    const conv = convStore.getCurrentConversation()
    if (conv) {
      const lastAssistant = [...conv.messages]
        .reverse()
        .find(m => m.role === 'assistant')
      if (lastAssistant) {
        convStore.updateConversation(conv.id, {
          messages: conv.messages.filter(m => m.id !== lastAssistant.id),
        })
      }
    }

    // 获取当前 provider/model 配置
    const settings = useSettingsStore.getState()
    const provider = settings.getCurrentProvider()
    const model = settings.getCurrentModel()
    if (!provider || !model || !hasConfiguredProviderCredentials(provider)) {
      return
    }

    const convId = convStore.currentConversationId
    if (!convId) return

    void (async () => {
      try {
        const aiConfig = await buildAIConfig(provider, model, settings)
        await get().sendMessage(
          convId,
          item.content,
          provider.type,
          aiConfig,
          item.attachments
        )
      } catch (error) {
        console.error('Failed to send buffered message:', error)
        set({
          error: error instanceof Error ? error.message : 'Failed to resolve credentials',
        })
      }
    })()
  },

  abortMessage: () => {
    const { abortController } = get()
    if (abortController) {
      abortController.abort()
      set({ isLoading: false, abortController: null })
    }
  },

  sendMessage: async (
    conversationId,
    content,
    providerType,
    config,
    attachments = [],
    options
  ) => {
    const controller = new AbortController()
    set({ isLoading: true, error: null, abortController: controller })

    // Add user message
    const messageId = uuidv4()
    const messageTimestamp = Date.now()
    const userMessage: Message = {
      id: messageId,
      role: 'user',
      content,
      timestamp: messageTimestamp,
      attachments: attachments.map(a => ({
        id: a.id,
        messageId: messageId,
        filename: a.filename,
        mimeType: a.mimeType,
        note: a.note || null,
        size: a.size,
        width: a.width,
        height: a.height,
        createdAt: new Date(messageTimestamp),
      })),
    }

    // Persist user message to database first
    await dbClient.messages.create({
      id: userMessage.id,
      conversationId,
      role: 'user',
      content,
      timestamp: new Date(userMessage.timestamp),
    })

    // Persist attachments to database
    for (const attachment of attachments) {
      const base64Data = attachment.dataUrl.split(',')[1]
      await window.api.attachments.create({
        id: attachment.id,
        messageId: userMessage.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        data: base64Data,
        note: attachment.note || null,
        size: attachment.size,
        width: attachment.width,
        height: attachment.height,
      })
    }

    // Add to memory after database save (so MessageImage can load from DB)
    useConversationStore.getState().addMessage(userMessage)

    // Get conversation for context
    let conversation = useConversationStore.getState().getCurrentConversation()
    if (!conversation) {
      set({ isLoading: false, error: 'No conversation found' })
      return
    }

    // --- 上下文压缩检测 ---
    const compressionEnabled =
      useSettingsStore.getState().contextCompressionEnabled
    const currentModel = useSettingsStore.getState().getCurrentModel()

    if (compressionEnabled && currentModel?.contextLength) {
      const lastAssistant = conversation.messages
        .filter(m => m.role === 'assistant' && m.inputTokens)
        .at(-1)

      if (lastAssistant?.inputTokens) {
        const ratio = lastAssistant.inputTokens / currentModel.contextLength
        const activeMessages = conversation.messages.filter(m => !m.compressed)

        if (
          ratio >= COMPRESSION_THRESHOLD &&
          activeMessages.length > KEEP_RECENT + 1
        ) {
          const toCompress = activeMessages.slice(0, -KEEP_RECENT)
          const toCompressIds = toCompress.map(m => m.id)

          const compressPayload: AIMessage[] = toCompress.map(m => ({
            role: m.role as 'user' | 'assistant',
            content:
              m.content.length > 500
                ? m.content.slice(0, 500) + '...'
                : m.content,
          }))

          let summaryContent: string
          try {
            summaryContent = await apiClient.compressMessages(
              providerType,
              compressPayload,
              config
            )
          } catch (err) {
            console.error(
              'AI compression failed, falling back to truncation:',
              err
            )
            summaryContent = generateTruncatedSummary(toCompress)
          }

          const summaryId = uuidv4()
          await window.api.ipc.invoke('db:messages:createSummary', {
            id: summaryId,
            conversationId,
            content: summaryContent,
            summaryOf: toCompressIds,
            timestamp: Date.now(),
          })

          await window.api.ipc.invoke('db:messages:markCompressed', {
            messageIds: toCompressIds,
          })

          const summaryMessage: Message = {
            id: summaryId,
            role: 'assistant',
            content: summaryContent,
            timestamp: Date.now(),
            summaryOf: toCompressIds,
            inputTokens: toCompress.reduce((s, m) => s + (m.inputTokens ?? 0), 0),
            outputTokens: toCompress.reduce((s, m) => s + (m.outputTokens ?? 0), 0),
          }

          const updatedMessages = [
            summaryMessage,
            ...conversation.messages.filter(m => !toCompressIds.includes(m.id)),
          ]

          useConversationStore.getState().updateConversation(conversationId, {
            messages: updatedMessages,
          })

          conversation = useConversationStore
            .getState()
            .getCurrentConversation()!
        }
      }
    }
    // --- 压缩检测结束 ---

    const buildContentBlocks = async (
      m: Message
    ): Promise<MessageContent[]> => {
      const contentBlocks: MessageContent[] = []

      if (m.content) {
        contentBlocks.push({ type: 'text', text: m.content })
      }

      if (m.attachments?.length && window.api?.attachments?.getBase64) {
        const imageBlocks = await Promise.all(
          m.attachments.map(async attachment => {
            const base64 = await window.api.attachments.getBase64(attachment.id)
            return base64
              ? {
                  type: 'image' as const,
                  mimeType: attachment.mimeType,
                  data: base64,
                  note: attachment.note || undefined,
                }
              : null
          })
        )
        const validImageBlocks = imageBlocks.filter(
          (block): block is NonNullable<(typeof imageBlocks)[number]> =>
            block !== null
        )
        contentBlocks.push(...validImageBlocks)
      }

      return contentBlocks
    }

    // Prepare messages for API (include history attachments)
    const historyMessages: AIMessage[] = await Promise.all(
      conversation.messages
        .filter(m => !m.compressed) // 过滤已压缩消息
        .map(async m => {
          if (m.attachments && m.attachments.length > 0) {
            return {
              role: m.role as 'user' | 'assistant',
              content: await buildContentBlocks(m),
            }
          }

          return {
            role: m.role as 'user' | 'assistant',
            content: m.content,
          }
        })
    )

    // Build system prompt with tool instructions
    const workspacePath = useConversationStore
      .getState()
      .getEffectiveWorkspace()

    // Get skills content based on selection mode
    const selectedSkill = useSettingsStore.getState().selectedSkill
    let skillsSection = ''

    try {
      if (selectedSkill) {
        // Manual mode: load specific skill content
        const skillContent = await dbClient.skills.getContent(selectedSkill)
        skillsSection = `\n\n## Active Skill\n\n${skillContent}`
      } else {
        // Auto mode: load all skills for AI to choose
        const skills = await dbClient.skills.getAll()
        if (skills.length > 0) {
          const skillsList = skills
            .map(
              s =>
                `- **${s.name}**: ${s.description || 'No description'}`
            )
            .join('\n')
          skillsSection = `\n\n## Available Skills\n\nThe following skills are available. Use them when relevant to the user's request:\n\n${skillsList}`
        }
      }
    } catch (error) {
      console.error('Failed to load skills:', error)
    }

    const systemPrompt = `## Tool Usage Rules
- Use the provided tools proactively to help users with coding tasks
- When asked about code, search for relevant files first. When modifying code, read and understand context before making changes
- If a tool returns an error, do NOT retry with the same parameters — try a different approach or ask the user
- If a tool call is denied, read the denial reason, suggest alternatives, and do NOT retry the denied call
${skillsSection}
Current workspace: ${workspacePath || 'Not set'}`

    // Get custom system prompts (append mode - don't override built-in)
    const globalSystemPrompt =
      useSettingsStore.getState().globalSystemPrompt || ''
    const conversationSystemPrompt = conversation.systemPrompt || ''

    // Merge custom prompts
    const customPrompts = [globalSystemPrompt, conversationSystemPrompt]
      .filter(Boolean)
      .join('\n\n')

    // 身份声明作为第一行，简洁直接（和 Cline/OpenHands 一致的做法）
    let finalSystemPrompt = `You are Crow, a desktop AI chat agent.\n\n${systemPrompt}`

    if (customPrompts) {
      finalSystemPrompt = `${finalSystemPrompt}\n\n## User Instructions\n\n${customPrompts}`
    }

    // Inject memory context if enabled
    const memoryEnabled = useSettingsStore.getState().memoryEnabled
    if (memoryEnabled) {
      try {
        const memoryBlock = await window.api.memory.getRelevant(
          workspacePath,
          content
        )
        if (memoryBlock) {
          finalSystemPrompt = `${finalSystemPrompt}\n\n${memoryBlock}`
        }
      } catch (error) {
        console.error('Failed to load memory context:', error)
      }
    }

    // Combine system prompt with history messages
    const aiMessages: AIMessage[] = [
      { role: 'system', content: finalSystemPrompt },
      ...historyMessages,
    ]

    // Add current message with attachments to API messages
    if (attachments.length > 0) {
      const lastMessage = aiMessages[aiMessages.length - 1]
      const contentBlocks: MessageContent[] = []

      // Add text content
      if (content) {
        contentBlocks.push({ type: 'text', text: content })
      }

      // Add image content from attachments
      for (const attachment of attachments) {
        const base64Data = attachment.dataUrl.split(',')[1]
        contentBlocks.push({
          type: 'image',
          mimeType: attachment.mimeType,
          data: base64Data,
          note: attachment.note || undefined,
        })
      }

      // Replace last message content with multimodal content
      aiMessages[aiMessages.length - 1] = {
        ...lastMessage,
        content: contentBlocks,
      }
    }

    // Create placeholder for assistant message
    const assistantMessageId = uuidv4()
    const startTime = Date.now()
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      toolResults: [],
    }

    useConversationStore.getState().addMessage(assistantMessage)

    // RAF-throttled streaming: buffer chunks and flush once per frame
    let pendingChunks: AIStreamChunk[] = []
    let rafId: number | null = null
    let flushChunks: () => void = () => {}

    try {
      const settingsState = useSettingsStore.getState()
      const workspacePath = useConversationStore
        .getState()
        .getEffectiveWorkspace()
      const toolPermissions =
        options?.toolPermissions ??
        settingsState.getToolPermissions(workspacePath)

      flushChunks = () => {
        rafId = null
        const chunks = pendingChunks
        pendingChunks = []
        if (chunks.length === 0) return

        // 使用 updateMessage 只更新目标消息，保持其他消息引用不变
        useConversationStore
          .getState()
          .updateMessage(conversationId, assistantMessageId, m => {
            const updated: Message = { ...m }

            for (const chunk of chunks) {
              if (chunk.content) {
                updated.content = (updated.content || '') + chunk.content
              }
              if (chunk.thinking) {
                updated.thinking = (updated.thinking || '') + chunk.thinking
              }
              if (chunk.toolCall) {
                const toolCalls = [...(updated.toolCalls || [])]
                const existingCall = toolCalls.find(
                  (tc: ToolCall) => tc.id === chunk.toolCall!.id
                )
                if (!existingCall) {
                  toolCalls.push(chunk.toolCall as ToolCall)
                  updated.toolCalls = toolCalls
                }
              }
              if (chunk.toolResult) {
                const toolResults = [...(updated.toolResults || [])]
                const existingResult = toolResults.find(
                  (tr: ToolResult) =>
                    tr.toolCallId === chunk.toolResult!.toolCallId
                )
                if (!existingResult) {
                  toolResults.push(chunk.toolResult as ToolResult)
                  updated.toolResults = toolResults
                }
              }
              if (chunk.done && chunk.usage) {
                updated.inputTokens = chunk.usage.inputTokens
                updated.outputTokens = chunk.usage.outputTokens
                updated.durationMs = Date.now() - startTime
              }
            }

            return updated
          })
      }

      // Send message with streaming
      const sessionTools = get().getSessionApprovedTools(conversationId)
      const mergedAllowOnce = [
        ...(options?.allowOnceTools || []),
        ...sessionTools,
      ]

      await apiClient.sendMessageStream(
        providerType,
        aiMessages,
        config,
        chunk => {
          pendingChunks.push(chunk)
          if (rafId === null) {
            rafId = requestAnimationFrame(flushChunks)
          }
        },
        controller.signal,
        {
          toolPermissions,
          allowOnceTools:
            mergedAllowOnce.length > 0 ? mergedAllowOnce : undefined,
        }
      )

      // Flush remaining buffered chunks after stream ends
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      flushChunks()

      // Persist assistant message to database after streaming completes
      const conversations = useConversationStore.getState().conversations
      const targetConv = conversations.find(c => c.id === conversationId)
      const finalAssistantMessage = targetConv?.messages.find(
        m => m.id === assistantMessageId
      )
      if (finalAssistantMessage) {
        await dbClient.messages.create({
          id: finalAssistantMessage.id,
          conversationId,
          role: 'assistant',
          content: finalAssistantMessage.content,
          thinking: finalAssistantMessage.thinking,
          timestamp: new Date(finalAssistantMessage.timestamp),
          inputTokens: finalAssistantMessage.inputTokens,
          outputTokens: finalAssistantMessage.outputTokens,
          durationMs: finalAssistantMessage.durationMs,
        })

        // 累加 token 到对话总计
        if (finalAssistantMessage.inputTokens || finalAssistantMessage.outputTokens) {
          const conv = useConversationStore
            .getState()
            .conversations.find(c => c.id === conversationId)
          window.api.conversation
            .addTokens(
              conversationId,
              finalAssistantMessage.inputTokens ?? 0,
              finalAssistantMessage.outputTokens ?? 0
            )
            .catch((err: unknown) => console.error('Failed to accumulate tokens:', err))
          if (conv) {
            useConversationStore.getState().updateConversation(conversationId, {
              totalInputTokens:
                (conv.totalInputTokens ?? 0) + (finalAssistantMessage.inputTokens ?? 0),
              totalOutputTokens:
                (conv.totalOutputTokens ?? 0) + (finalAssistantMessage.outputTokens ?? 0),
            })
          }
        }
      }

      // Update conversation title if it's the first user message
      const currentConv = useConversationStore
        .getState()
        .conversations.find(c => c.id === conversationId)
      if (
        currentConv &&
        currentConv.messages.filter(m => m.role === 'user').length === 1
      ) {
        const title = content.slice(0, 50) + (content.length > 50 ? '...' : '')
        useConversationStore
          .getState()
          .renameConversation(conversationId, title)
      }

      // P1: Auto-extract memories every 5 rounds (fire-and-forget)
      if (memoryEnabled && currentConv) {
        const userMsgCount = currentConv.messages.filter(
          m => m.role === 'user'
        ).length
        if (userMsgCount >= 5 && userMsgCount % 5 === 0) {
          const settings = useSettingsStore.getState()
          const pid = settings.currentProviderId
          const mid = settings.currentModelId
          if (pid && mid) {
            triggerMemoryExtraction(conversationId, pid, mid).catch(err =>
              console.error('Background memory extraction failed:', err)
            )
          }
        }
      }
    } catch (error) {
      // Ignore abort errors (user cancelled)
      if (error instanceof Error && error.name === 'AbortError') {
        // Flush buffered chunks so already-received content is not lost
        if (rafId !== null) {
          cancelAnimationFrame(rafId)
          rafId = null
        }
        flushChunks()
        return
      }

      console.error('Failed to send message:', error)

      // Parse error using structured error types
      let errorMessage = 'Unknown error'
      let apiError: APIError | null = null
      let isRetryable = false

      if (error instanceof APIClientError) {
        // Use structured error from API client
        apiError = error.apiError || null
        errorMessage = apiError?.message || error.message
        isRetryable = error.retryable
      } else if (error instanceof Error) {
        // Fallback for non-APIClientError
        errorMessage = error.message || getErrorMessage(ErrorCode.INTERNAL_ERROR)
      }

      // Update assistant message with error (use updateMessage to preserve sibling refs)
      useConversationStore
        .getState()
        .updateMessage(conversationId, assistantMessageId, m => ({
          ...m,
          content: `Error: ${errorMessage}`,
        }))

      set({ error: errorMessage, lastError: apiError, retryable: isRetryable })
    } finally {
      set({ isLoading: false, abortController: null })

      // 自动消费缓冲区
      const buffer = get().messageBuffer
      if (buffer.length > 0) {
        const next = buffer[0]
        set({ messageBuffer: buffer.slice(1) })
        // 延迟一帧再发送，避免状态竞争
        setTimeout(() => {
          get().sendMessage(
            conversationId,
            next.content,
            providerType,
            config,
            undefined
          )
        }, 0)
      }
    }
  },

  approveToolCall: async (conversationId, toolName, scope) => {
    const settingsState = useSettingsStore.getState()
    const workspacePath = useConversationStore
      .getState()
      .getEffectiveWorkspace()
    const provider = settingsState.getCurrentProvider()
    const model = settingsState.getCurrentModel()

    if (!provider || !model) {
      set({ error: 'No provider or model selected' })
      return
    }

    if (!hasConfiguredProviderCredentials(provider)) {
      set({ error: 'Provider auth missing' })
      return
    }

    // 根据 scope 处理授权
    switch (scope) {
      case 'once':
        // 不做额外存储，仅通过 allowOnceTools 传递
        break

      case 'session':
        // 存储到 sessionApprovals
        set(state => {
          const current = state.sessionApprovals[conversationId] || []
          if (!current.includes(toolName)) {
            return {
              sessionApprovals: {
                ...state.sessionApprovals,
                [conversationId]: [...current, toolName],
              },
            }
          }
          return state
        })
        break

      case 'project':
        // P1 实现：写入 .crow/permissions.json
        // P0 阶段 fallback 到 session
        set(state => {
          const current = state.sessionApprovals[conversationId] || []
          if (!current.includes(toolName)) {
            return {
              sessionApprovals: {
                ...state.sessionApprovals,
                [conversationId]: [...current, toolName],
              },
            }
          }
          return state
        })
        break

      case 'global':
        // P1 实现：写入 ~/.crow/permissions.json
        // P0 阶段 fallback 到 allowAll
        settingsState.setToolAllowAll(workspacePath ?? '', true)
        break
    }

    const aiConfig = await buildAIConfig(provider, model, settingsState)

    const message = `[Tool Approved] The user approved the "${toolName}" tool. Please proceed with the operation.`

    await get().sendMessage(
      conversationId,
      message,
      provider.type,
      aiConfig,
      [],
      { allowOnceTools: [toolName] }
    )
  },

  denyToolCall: async (conversationId, toolName, toolCallId, reason?) => {
    const settingsState = useSettingsStore.getState()
    const provider = settingsState.getCurrentProvider()
    const model = settingsState.getCurrentModel()

    if (!provider || !model) {
      set({ error: 'No provider or model selected' })
      return
    }
    if (!hasConfiguredProviderCredentials(provider)) {
      set({ error: 'Provider auth missing' })
      return
    }

    const denyMessage = reason
      ? `[Tool Denied] The user denied the "${toolName}" tool call (ID: ${toolCallId}). Reason: ${reason}. Please adjust your approach.`
      : `[Tool Denied] The user denied the "${toolName}" tool call (ID: ${toolCallId}). Please try a different approach or ask the user for guidance.`

    const aiConfig = await buildAIConfig(provider, model, settingsState)

    // 发送 deny 消息作为用户消息，触发 AI 继续对话
    await get().sendMessage(
      conversationId,
      denyMessage,
      provider.type,
      aiConfig
    )
  },

  getSessionApprovedTools: (conversationId: string) => {
    return get().sessionApprovals[conversationId] || []
  },
}))
