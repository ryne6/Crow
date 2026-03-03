import { useState, useRef, KeyboardEvent, useEffect, useCallback } from 'react'
import { Send, Square, Maximize2, Brain, X } from 'lucide-react'
import { v4 as uuidv4 } from 'uuid'
import { Button } from '../ui/button'
import { useChatStore } from '~/stores/chatStore'
import { triggerCompression } from '~/stores/chatStore'
import { useConversationStore } from '~/stores/conversationStore'
import { useSettingsStore } from '~/stores/settingsStore'
import { notify } from '~/utils/notify'
import { ImageUploadButton } from './ImageUploadButton'
import { ImagePreview } from './ImagePreview'
import { ImageDropZone } from './ImageDropZone'
import { FullscreenEditor } from './FullscreenEditor'
import { ToolsSkillsPanel } from './ToolsSkillsPanel'
import { useSkillMention } from './SkillMention'
import { useSlashCommand } from './SlashCommand'
import { WorkspaceDropdown } from './WorkspaceDropdown'
import { ModelSelector } from './ModelSelector'
import { ContextIndicator } from './ContextIndicator'
import type { AIConfig } from '~shared/types/ai'
import type { PendingAttachment } from '~shared/types/attachment'
import { dbClient } from '~/services/dbClient'

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

export function ChatInput() {
  const [input, setInput] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([])
  const [isFullscreen, setIsFullscreen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { sendMessage, isLoading, abortMessage, enqueueMessage } =
    useChatStore()
  const { getCurrentConversation, createConversation } = useConversationStore()
  const {
    getCurrentProvider,
    getCurrentModel,
    temperature,
    thinkingEnabled,
    setThinkingEnabled,
    selectedSkill,
    setSelectedSkill,
    loadData,
  } = useSettingsStore()

  const {
    handleInputChange: handleMentionChange,
    handleKeyDown: handleMentionKeyDown,
    mentionMenu,
  } = useSkillMention({
    inputValue: input,
    onInputChange: setInput,
    textareaRef,
  })

  const conversation = getCurrentConversation()
  const currentModel = getCurrentModel()

  // Derive last inputTokens from most recent assistant message
  const lastAssistantMsg = conversation?.messages
    ?.filter(m => m.role === 'assistant' && m.inputTokens)
    .at(-1)
  const lastInputTokens = lastAssistantMsg?.inputTokens ?? null
  // 对话级累计 token
  const totalTokens = conversation?.totalInputTokens ?? null

  // Load provider and model data on mount
  useEffect(() => {
    loadData()
  }, [loadData])

  // Convert File to PendingAttachment
  const fileToAttachment = useCallback(
    async (file: File): Promise<PendingAttachment> => {
      return new Promise(resolve => {
        const reader = new FileReader()
        reader.onload = () => {
          const img = new Image()
          img.onload = () => {
            resolve({
              id: uuidv4(),
              file,
              filename: file.name,
              mimeType: file.type,
              dataUrl: reader.result as string,
              note: '',
              size: file.size,
              width: img.width,
              height: img.height,
            })
          }
          img.src = reader.result as string
        }
        reader.readAsDataURL(file)
      })
    },
    []
  )

  // Handle image selection
  const handleImagesSelected = useCallback(
    async (files: File[]) => {
      const attachments = await Promise.all(files.map(fileToAttachment))
      setPendingAttachments(prev => [...prev, ...attachments])
    },
    [fileToAttachment]
  )

  // Remove pending attachment
  const handleRemoveAttachment = useCallback((id: string) => {
    setPendingAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  // Update attachment note
  const handleNoteChange = useCallback((id: string, note: string) => {
    setPendingAttachments(prev =>
      prev.map(a => (a.id === id ? { ...a, note } : a))
    )
  }, [])

  // Handle memory slash commands
  const handleMemoryCommand = useCallback(
    async (message: string): Promise<boolean> => {
      const memoryEnabled = useSettingsStore.getState().memoryEnabled
      const workspacePath = useConversationStore
        .getState()
        .getEffectiveWorkspace()

      if (message === '~main/memories') {
        if (!memoryEnabled) {
          notify.info('记忆功能未开启，请在设置中开启')
          return true
        }
        try {
          const memories = await window.api.memory.getAll()
          if (memories.length === 0) {
            notify.info('暂无记忆')
          } else {
            const summary = memories
              .slice(0, 10)
              .map(m => `[${m.category}] ${m.content}`)
              .join('\n')
            notify.info(`当前记忆 (${memories.length} 条):\n${summary}`)
          }
        } catch {
          notify.error('获取记忆失败')
        }
        return true
      }

      if (message.startsWith('~main/remember-project ')) {
        if (!memoryEnabled) {
          notify.info('记忆功能未开启，请在设置中开启')
          return true
        }
        const content = message.slice('~main/remember-project '.length).trim()
        if (!content) return true
        try {
          await window.api.memory.remember(
            content,
            'project',
            workspacePath || undefined
          )
          notify.success('已保存到项目记忆')
        } catch {
          notify.error('保存记忆失败')
        }
        return true
      }

      if (message.startsWith('~main/remember ')) {
        if (!memoryEnabled) {
          notify.info('记忆功能未开启，请在设置中开启')
          return true
        }
        const content = message.slice('~main/remember '.length).trim()
        if (!content) return true
        try {
          await window.api.memory.remember(content, 'user')
          notify.success('已保存到用户记忆')
        } catch {
          notify.error('保存记忆失败')
        }
        return true
      }

      if (message.startsWith('~main/forget ')) {
        if (!memoryEnabled) {
          notify.info('记忆功能未开启，请在设置中开启')
          return true
        }
        const keyword = message.slice('~main/forget '.length).trim()
        if (!keyword) return true
        try {
          const result = await window.api.memory.forget(
            keyword,
            workspacePath || undefined
          )
          notify.success(`已删除 ${result.deletedCount} 条匹配的记忆`)
        } catch {
          notify.error('删除记忆失败')
        }
        return true
      }

      return false
    },
    []
  )

  // /compact 手动压缩命令
  const handleCompactCommand = useCallback(
    async (message: string): Promise<boolean> => {
      if (message !== '~main/compact') return false

      const conv = getCurrentConversation()
      if (!conv) {
        notify.info('没有活跃的对话')
        return true
      }

      const provider = getCurrentProvider()
      const model = getCurrentModel()
      if (!provider || !model) {
        notify.error('请先配置 AI 供应商')
        return true
      }
      if (!hasConfiguredProviderCredentials(provider)) {
        notify.error(`请先配置 ${provider.name} 的鉴权信息`)
        return true
      }

      notify.info('正在压缩对话上下文...')

      try {
        const resolvedCredentials = await dbClient.providers.resolveCredentials(
          provider.id
        )

        const aiConfig: AIConfig = {
          providerId: provider.id,
          authType: resolvedCredentials.authType,
          oauthProvider: resolvedCredentials.oauthProvider || undefined,
          apiKey: resolvedCredentials.apiKey,
          model: model.modelId,
          baseURL: provider.baseURL || undefined,
          apiFormat: provider.apiFormat || 'chat-completions',
          temperature,
          maxTokens: 4096,
          thinkingEnabled: false,
        }

        const result = await triggerCompression(
          conv.id,
          provider.type,
          aiConfig
        )

        if (result.compressed) {
          notify.success(`已压缩 ${result.count} 条消息`)
        } else {
          notify.info('消息数量不足，无需压缩')
        }
      } catch {
        notify.error('压缩失败')
      }
      return true
    },
    [getCurrentConversation, getCurrentProvider, getCurrentModel, temperature]
  )

  // / 斜杠命令：immediate 命令直接走对应 handler
  const executeSlashCommand = useCallback(
    async (cmd: string) => {
      if (await handleMemoryCommand(cmd)) return
      if (await handleCompactCommand(cmd)) return
    },
    [handleMemoryCommand, handleCompactCommand]
  )

  const {
    handleInputChange: handleSlashChange,
    handleKeyDown: handleSlashKeyDown,
    slashMenu,
  } = useSlashCommand({
    inputValue: input,
    onInputChange: handleMentionChange,
    onExecute: executeSlashCommand,
    textareaRef,
  })

  const handleSend = async () => {
    if (!input.trim() && pendingAttachments.length === 0) return

    // 生成中时，将消息入队到缓冲区
    if (isLoading) {
      const enqueued = enqueueMessage(input.trim(), pendingAttachments)
      if (enqueued) {
        setInput('')
        setPendingAttachments([])
      } else {
        console.warn('缓冲队列已满（最多 5 条），请等待当前生成完成')
      }
      return
    }

    const provider = getCurrentProvider()
    const model = getCurrentModel()

    if (!provider || !model) {
      notify.error('Please select a provider and model in Settings')
      return
    }

    if (!hasConfiguredProviderCredentials(provider)) {
      notify.error(`Please configure auth for ${provider.name} in Settings`)
      return
    }

    // Create conversation if none exists
    let currentConversation = conversation
    if (!currentConversation) {
      currentConversation = await createConversation()
    }

    const message = input.trim()
    const attachments = [...pendingAttachments]
    setInput('')
    setPendingAttachments([])

    // Intercept memory slash commands
    if (await handleMemoryCommand(message)) return

    // Intercept /compact command
    if (await handleCompactCommand(message)) return

    try {
      const resolvedCredentials = await dbClient.providers.resolveCredentials(
        provider.id
      )

      // Construct AI config from database provider/model
      const aiConfig: AIConfig = {
        providerId: provider.id,
        authType: resolvedCredentials.authType,
        oauthProvider: resolvedCredentials.oauthProvider || undefined,
        apiKey: resolvedCredentials.apiKey,
        model: model.modelId,
        baseURL: provider.baseURL || undefined,
        apiFormat: provider.apiFormat || 'chat-completions',
        temperature,
        maxTokens: 4096,
        thinkingEnabled,
      }

      await sendMessage(
        currentConversation.id,
        message,
        provider.type,
        aiConfig,
        attachments
      )
    } catch (error) {
      console.error('Failed to send message:', error)
      notify.error(
        `Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // / 斜杠命令键盘导航优先
    if (handleSlashKeyDown(e)) return
    // @ mention 键盘导航优先
    if (handleMentionKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <>
      <div className="border-t border-[hsl(var(--border))]">
        {/* Pending Attachments Preview */}
        {pendingAttachments.length > 0 && (
          <div className="px-4 py-2 border-b flex gap-2 flex-wrap">
            {pendingAttachments.map(attachment => (
              <ImagePreview
                key={attachment.id}
                attachment={attachment}
                onRemove={() => handleRemoveAttachment(attachment.id)}
                onNoteChange={note => handleNoteChange(attachment.id, note)}
              />
            ))}
          </div>
        )}

        {/* Input Area */}
        <ImageDropZone
          onImagesDropped={handleImagesSelected}
          disabled={isLoading}
        >
          <div className="px-6 py-4">
            <div className="rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--bg-main))] shadow-[0_4px_12px_rgba(0,0,0,0.05)] overflow-hidden">
              {/* Text Input Area with Fullscreen Button */}
              <div className="relative p-3 pb-2">
                {/* 选中 Skill badge */}
                {selectedSkill && (
                  <div className="flex items-center gap-1 mb-2">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[hsl(var(--surface-2))] text-[hsl(var(--text-muted))]">
                      Skill:{' '}
                      {selectedSkill.split('/').pop()?.replace('.md', '') ||
                        'Active'}
                      <button
                        onClick={() => setSelectedSkill(null)}
                        className="hover:text-[hsl(var(--text))] transition-colors"
                        aria-label="Clear skill selection"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  </div>
                )}
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={e => handleSlashChange(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="从任何想法开始… (/ 命令, @ 选择 Skill)"
                  aria-label="Message input"
                  className="w-full resize-none bg-transparent text-[15px] min-h-[60px] max-h-[200px] focus:outline-none"
                  rows={3}
                />
                {/* Fullscreen Button */}
                <button
                  onClick={() => setIsFullscreen(true)}
                  className="absolute top-3 right-3 p-1.5 rounded hover:bg-[hsl(var(--surface-2))] text-[hsl(var(--text-muted))] transition-colors"
                  aria-label="Fullscreen edit"
                >
                  <Maximize2 className="w-4 h-4" />
                </button>
              </div>

              {/* Toolbar */}
              <div className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-2">
                  {/* Image Upload */}
                  <ImageUploadButton
                    onImagesSelected={handleImagesSelected}
                    disabled={isLoading}
                  />

                  {/* Model Selector */}
                  <ModelSelector />

                  <div className="flex items-center">
                    {/* Workspace Dropdown */}
                    <WorkspaceDropdown />

                    {/* Tools & Skills Panel */}
                    <ToolsSkillsPanel />
                  </div>

                  {/* Thinking Toggle */}
                  <button
                    onClick={() => setThinkingEnabled(!thinkingEnabled)}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded text-sm transition-colors ${
                      thinkingEnabled
                        ? 'bg-blue-100 text-blue-600'
                        : 'hover:bg-[hsl(var(--surface-2))] text-[hsl(var(--text-muted))]'
                    }`}
                  >
                    <Brain className="w-4 h-4" />
                    <span>Thinking</span>
                  </button>

                  {/* Context Usage Indicator */}
                  <ContextIndicator
                    usedTokens={lastInputTokens}
                    totalConsumed={totalTokens}
                    contextLength={currentModel?.contextLength ?? null}
                  />
                </div>

                {/* Send / Stop Buttons */}
                <div className="flex items-center gap-1">
                  {isLoading && (
                    <Button
                      onClick={abortMessage}
                      size="icon"
                      variant="destructive"
                      className="h-8 w-8 rounded-md shrink-0"
                      aria-label="Stop generation"
                    >
                      <Square className="w-4 h-4" />
                    </Button>
                  )}
                  <Button
                    onClick={handleSend}
                    disabled={
                      !input.trim() && pendingAttachments.length === 0
                    }
                    size="icon"
                    className="h-8 w-8 rounded-md shrink-0"
                    aria-label={
                      isLoading ? 'Enqueue message' : 'Send message'
                    }
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </ImageDropZone>
      </div>

      {/* Fullscreen Editor */}
      {isFullscreen && (
        <FullscreenEditor
          value={input}
          onChange={setInput}
          onClose={() => setIsFullscreen(false)}
          onSend={handleSend}
          isLoading={isLoading}
        />
      )}

      {/* @ Skill Mention 浮层 */}
      {mentionMenu}

      {/* / 斜杠命令浮层 */}
      {slashMenu}
    </>
  )
}
