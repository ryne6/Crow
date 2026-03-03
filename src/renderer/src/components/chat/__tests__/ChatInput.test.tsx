/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatInput } from '../ChatInput'

/**
 * ChatInput 组件测试
 *
 * 测试目标：
 * - 消息输入和发送
 * - 发送按钮禁用状态
 * - 错误处理和通知
 * - 多 store 状态同步
 */

// Use vi.hoisted to ensure mocks are set up before imports
const {
  mockChatStore,
  mockConversationStore,
  mockSettingsStore,
  mockNotify,
  mockDbClient,
} =
  vi.hoisted(() => {
    // Create mock stores directly
    const chatStoreState = {
      isLoading: false,
      error: null,
    }

    const conversationStoreState = {
      conversations: [],
      currentConversationId: null,
      isLoading: false,
    }

    const settingsStoreState = {
      currentProviderId: 'provider-1',
      currentModelId: 'model-1',
      temperature: 1,
      thinkingEnabled: false,
      memoryEnabled: false,
      lastUpdated: Date.now(),
      providers: [
        {
          id: 'provider-1',
          name: 'Test Provider',
          type: 'openai',
          apiKey: 'test-api-key',
          enabled: true,
        },
      ],
      models: [
        {
          id: 'model-1',
          providerId: 'provider-1',
          modelId: 'gpt-4',
          name: 'GPT-4',
          enabled: true,
        },
      ],
    }

    return {
      mockChatStore: {
        ...chatStoreState,
        sendMessage: vi.fn(async () => {
          chatStoreState.isLoading = true
          await new Promise(resolve => setTimeout(resolve, 10))
          chatStoreState.isLoading = false
        }),
        abortMessage: vi.fn(),
        getState: vi.fn(() => ({ ...chatStoreState })),
        setState: vi.fn((newState: any) => {
          Object.assign(
            chatStoreState,
            typeof newState === 'function' ? newState(chatStoreState) : newState
          )
        }),
        subscribe: vi.fn(() => vi.fn()),
      },
      mockConversationStore: {
        ...conversationStoreState,
        getCurrentConversation: vi.fn(() => null),
        getEffectiveWorkspace: vi.fn(() => '~main/test/workspace'),
        createConversation: vi.fn(async (title?: string) => ({
          id: 'new-conv-id',
          title: title ?? 'New Conversation',
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })),
        getState: vi.fn(() => ({ ...conversationStoreState })),
        setState: vi.fn((newState: any) => {
          Object.assign(
            conversationStoreState,
            typeof newState === 'function'
              ? newState(conversationStoreState)
              : newState
          )
        }),
        subscribe: vi.fn(() => vi.fn()),
      },
      mockSettingsStore: {
        ...settingsStoreState,
        loadData: vi.fn(async () => {}),
        getCurrentProvider: vi.fn(() => settingsStoreState.providers[0]),
        getCurrentModel: vi.fn(() => settingsStoreState.models[0]),
        getEnabledModels: vi.fn(() => {
          const enabledProviderIds = settingsStoreState.providers
            .filter(provider => provider.enabled)
            .map(provider => provider.id)
          return settingsStoreState.models.filter(
            model =>
              model.enabled && enabledProviderIds.includes(model.providerId)
          )
        }),
        setThinkingEnabled: vi.fn((value: boolean) => {
          settingsStoreState.thinkingEnabled = value
        }),
        setCurrentProvider: vi.fn(async (providerId: string) => {
          settingsStoreState.currentProviderId = providerId
        }),
        setCurrentModel: vi.fn(async (modelId: string) => {
          settingsStoreState.currentModelId = modelId
        }),
        setTemperature: vi.fn((temperature: number) => {
          settingsStoreState.temperature = temperature
        }),
        getState: vi.fn(() => ({ ...settingsStoreState })),
        setState: vi.fn((newState: any) => {
          Object.assign(
            settingsStoreState,
            typeof newState === 'function'
              ? newState(settingsStoreState)
              : newState
          )
        }),
        subscribe: vi.fn(() => vi.fn()),
      },
      mockNotify: {
        error: vi.fn(),
        success: vi.fn(),
        info: vi.fn(),
      },
      mockDbClient: {
        providers: {
          resolveCredentials: vi.fn(async () => ({
            apiKey: 'resolved-api-key',
            authType: 'api_key',
            oauthProvider: null,
            accountEmail: null,
            expiresAt: null,
          })),
        },
      },
    }
  })

// Mock Zustand stores — each mock must be both callable (hook) and have .getState()
vi.mock('~/stores/chatStore', () => {
  const hook = () => mockChatStore
  hook.getState = () => mockChatStore
  hook.setState = mockChatStore.setState
  hook.subscribe = mockChatStore.subscribe
  return { useChatStore: hook }
})

vi.mock('~/stores/conversationStore', () => {
  const hook = () => mockConversationStore
  hook.getState = () => mockConversationStore
  hook.setState = mockConversationStore.setState
  hook.subscribe = mockConversationStore.subscribe
  return { useConversationStore: hook }
})

vi.mock('~/stores/settingsStore', () => {
  const hook = () => mockSettingsStore
  hook.getState = () => mockSettingsStore
  hook.setState = mockSettingsStore.setState
  hook.subscribe = mockSettingsStore.subscribe
  return { useSettingsStore: hook }
})

vi.mock('../ToolsSkillsPanel', () => ({
  ToolsSkillsPanel: () => null,
}))

vi.mock('../SkillMention', () => ({
  useSkillMention: ({ onInputChange }: { onInputChange: (v: string) => void }) => ({
    handleInputChange: (v: string) => onInputChange(v),
    handleKeyDown: () => false,
    mentionMenu: null,
    isOpen: false,
  }),
}))

vi.mock('../SlashCommand', () => ({
  useSlashCommand: ({ onInputChange }: { onInputChange: (v: string) => void }) => ({
    handleInputChange: (v: string) => onInputChange(v),
    handleKeyDown: () => false,
    slashMenu: null,
  }),
}))

// Mock notify utility
vi.mock('~/utils/notify', () => ({
  notify: mockNotify,
}))

vi.mock('~/services/dbClient', () => ({
  dbClient: mockDbClient,
}))

describe('ChatInput', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks()
    mockChatStore.isLoading = false
    mockConversationStore.getCurrentConversation.mockReturnValue(null)
    mockConversationStore.createConversation.mockResolvedValue({
      id: 'new-conv-id',
      title: 'New Conversation',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    mockSettingsStore.getCurrentProvider.mockReturnValue(
      mockSettingsStore.providers[0]
    )
    mockSettingsStore.getCurrentModel.mockReturnValue(
      mockSettingsStore.models[0]
    )
    mockSettingsStore.thinkingEnabled = false
  })

  describe('渲染测试', () => {
    it('should render input textarea', () => {
      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')
      expect(textarea).toBeInTheDocument()
      expect(
        screen.getByPlaceholderText(/从任何想法开始/)
      ).toBeInTheDocument()
    })

    it('should render send button', () => {
      render(<ChatInput />)

      const sendButton = screen.getByLabelText('Send message')
      expect(sendButton).toBeInTheDocument()
    })

    it('should render model selector with provider name', () => {
      render(<ChatInput />)

      expect(screen.getByText('GPT-4')).toBeInTheDocument()
      expect(screen.getByText('(Test Provider)')).toBeInTheDocument()
    })
  })

  describe('输入功能测试', () => {
    it('should update input value when typing', async () => {
      const user = userEvent.setup()
      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')
      await user.type(textarea, 'Hello, world!')

      expect(textarea).toHaveValue('Hello, world!')
    })

    it('should clear input after sending message', async () => {
      const user = userEvent.setup()

      // Setup: conversation exists
      mockConversationStore.getCurrentConversation.mockReturnValue({
        id: 'conv-1',
        title: 'Test Conversation',
      })

      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')
      const sendButton = screen.getByLabelText('Send message')

      await user.type(textarea, 'Test message')
      await user.click(sendButton)

      await waitFor(() => {
        expect(textarea).toHaveValue('')
      })
    })
  })

  describe('发送按钮禁用状态测试', () => {
    it('should disable send button when input is empty', () => {
      render(<ChatInput />)

      const sendButton = screen.getByLabelText('Send message')
      expect(sendButton).toBeDisabled()
    })

    it('should disable send button when input contains only whitespace', async () => {
      const user = userEvent.setup()
      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')
      const sendButton = screen.getByLabelText('Send message')

      await user.type(textarea, '   ')
      expect(sendButton).toBeDisabled()
    })

    it('should enable send button when input has content', async () => {
      const user = userEvent.setup()
      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')
      const sendButton = screen.getByLabelText('Send message')

      await user.type(textarea, 'Hello')
      expect(sendButton).not.toBeDisabled()
    })

    it('should show stop button when loading', () => {
      // Setup: isLoading = true
      mockChatStore.isLoading = true

      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')
      const stopButton = screen.getByLabelText('Stop generation')

      expect(textarea).not.toBeDisabled()
      expect(stopButton).toBeInTheDocument()
      expect(screen.queryByLabelText('Send message')).not.toBeInTheDocument()

      // Reset
      mockChatStore.isLoading = false
    })
  })

  describe('错误处理测试', () => {
    it('should show error when provider is not selected', async () => {
      const user = userEvent.setup()

      // Setup: no provider selected
      mockSettingsStore.getCurrentProvider.mockReturnValue(null)
      mockConversationStore.getCurrentConversation.mockReturnValue({
        id: 'conv-1',
        title: 'Test Conversation',
      })

      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')
      const sendButton = screen.getByLabelText('Send message')

      await user.type(textarea, 'Test message')
      await user.click(sendButton)

      await waitFor(() => {
        expect(mockNotify.error).toHaveBeenCalledWith(
          'Please select a provider and model in Settings'
        )
      })
    })

    it('should show error when model is not selected', async () => {
      const user = userEvent.setup()

      // Setup: provider exists but no model
      mockSettingsStore.getCurrentProvider.mockReturnValue({
        id: 'provider-1',
        name: 'Test Provider',
        type: 'openai',
        apiKey: 'test-key',
        enabled: true,
      })
      mockSettingsStore.getCurrentModel.mockReturnValue(null)
      mockConversationStore.getCurrentConversation.mockReturnValue({
        id: 'conv-1',
        title: 'Test Conversation',
      })

      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')
      const sendButton = screen.getByLabelText('Send message')

      await user.type(textarea, 'Test message')
      await user.click(sendButton)

      await waitFor(() => {
        expect(mockNotify.error).toHaveBeenCalledWith(
          'Please select a provider and model in Settings'
        )
      })
    })

    it('should show error when API key is missing', async () => {
      const user = userEvent.setup()

      // Setup: provider without API key
      mockSettingsStore.getCurrentProvider.mockReturnValue({
        id: 'provider-1',
        name: 'Test Provider',
        type: 'openai',
        apiKey: '', // No API key
        enabled: true,
      })
      mockSettingsStore.getCurrentModel.mockReturnValue({
        id: 'model-1',
        providerId: 'provider-1',
        modelId: 'gpt-4',
        name: 'GPT-4',
        enabled: true,
      })
      mockConversationStore.getCurrentConversation.mockReturnValue({
        id: 'conv-1',
        title: 'Test Conversation',
      })

      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')
      const sendButton = screen.getByLabelText('Send message')

      await user.type(textarea, 'Test message')
      await user.click(sendButton)

      await waitFor(() => {
        expect(mockNotify.error).toHaveBeenCalledWith(
          'Please configure auth for Test Provider in Settings'
        )
      })
    })
  })

  describe('键盘事件测试', () => {
    it('should send message when pressing Enter', async () => {
      const user = userEvent.setup()

      // Setup: conversation exists with valid provider and model
      mockConversationStore.getCurrentConversation.mockReturnValue({
        id: 'conv-1',
        title: 'Test Conversation',
      })
      mockSettingsStore.getCurrentProvider.mockReturnValue({
        id: 'provider-1',
        name: 'Test Provider',
        type: 'openai',
        apiKey: 'test-api-key',
        enabled: true,
      })
      mockSettingsStore.getCurrentModel.mockReturnValue({
        id: 'model-1',
        providerId: 'provider-1',
        modelId: 'gpt-4',
        name: 'GPT-4',
        enabled: true,
      })

      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')

      await user.type(textarea, 'Test message{Enter}')

      await waitFor(() => {
        expect(mockChatStore.sendMessage).toHaveBeenCalled()
      })
    })

    it('should insert newline when pressing Shift+Enter', async () => {
      const user = userEvent.setup()
      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')

      await user.type(textarea, 'Line 1')
      await user.keyboard('{Shift>}{Enter}{/Shift}')
      await user.type(textarea, 'Line 2')

      expect(textarea).toHaveValue('Line 1\nLine 2')
    })

    it('should not send message when input is empty and Enter is pressed', async () => {
      const user = userEvent.setup()
      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')
      await user.click(textarea)
      await user.keyboard('{Enter}')

      expect(mockChatStore.sendMessage).not.toHaveBeenCalled()
    })
  })

  describe('自动创建对话测试', () => {
    it('should create conversation if none exists when sending message', async () => {
      const user = userEvent.setup()

      // Setup: no conversation exists but valid provider and model
      mockConversationStore.getCurrentConversation.mockReturnValue(null)
      mockConversationStore.createConversation.mockResolvedValue({
        id: 'new-conv-id',
        title: 'New Conversation',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      mockSettingsStore.getCurrentProvider.mockReturnValue({
        id: 'provider-1',
        name: 'Test Provider',
        type: 'openai',
        apiKey: 'test-api-key',
        enabled: true,
      })
      mockSettingsStore.getCurrentModel.mockReturnValue({
        id: 'model-1',
        providerId: 'provider-1',
        modelId: 'gpt-4',
        name: 'GPT-4',
        enabled: true,
      })

      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')
      const sendButton = screen.getByLabelText('Send message')

      await user.type(textarea, 'First message')
      await user.click(sendButton)

      await waitFor(() => {
        expect(mockConversationStore.createConversation).toHaveBeenCalled()
      })
    })

    it('should not create conversation if one already exists', async () => {
      const user = userEvent.setup()

      // Setup: conversation exists
      mockConversationStore.getCurrentConversation.mockReturnValue({
        id: 'existing-conv-id',
        title: 'Existing Conversation',
      })

      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')
      const sendButton = screen.getByLabelText('Send message')

      await user.type(textarea, 'Test message')
      await user.click(sendButton)

      await waitFor(() => {
        expect(mockConversationStore.createConversation).not.toHaveBeenCalled()
      })
    })
  })

  describe('发送消息功能测试', () => {
    it('should call sendMessage with correct parameters', async () => {
      const user = userEvent.setup()

      // Setup: conversation exists with valid provider and model
      mockConversationStore.getCurrentConversation.mockReturnValue({
        id: 'conv-1',
        title: 'Test Conversation',
      })
      mockSettingsStore.getCurrentProvider.mockReturnValue({
        id: 'provider-1',
        name: 'Test Provider',
        type: 'openai',
        apiKey: 'test-api-key',
        enabled: true,
      })
      mockSettingsStore.getCurrentModel.mockReturnValue({
        id: 'model-1',
        providerId: 'provider-1',
        modelId: 'gpt-4',
        name: 'GPT-4',
        enabled: true,
      })

      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')
      const sendButton = screen.getByLabelText('Send message')

      await user.type(textarea, 'Test message')
      await user.click(sendButton)

      await waitFor(() => {
        expect(mockChatStore.sendMessage).toHaveBeenCalledWith(
          'conv-1',
          'Test message',
          'openai',
          expect.objectContaining({
            apiKey: 'resolved-api-key',
            model: 'gpt-4',
            temperature: 1,
          }),
          [] // attachments
        )
      })
    })

    it('should trim whitespace from message before sending', async () => {
      const user = userEvent.setup()

      mockConversationStore.getCurrentConversation.mockReturnValue({
        id: 'conv-1',
        title: 'Test Conversation',
      })
      mockSettingsStore.getCurrentProvider.mockReturnValue({
        id: 'provider-1',
        name: 'Test Provider',
        type: 'openai',
        apiKey: 'test-api-key',
        enabled: true,
      })
      mockSettingsStore.getCurrentModel.mockReturnValue({
        id: 'model-1',
        providerId: 'provider-1',
        modelId: 'gpt-4',
        name: 'GPT-4',
        enabled: true,
      })

      render(<ChatInput />)

      const textarea = screen.getByLabelText('Message input')
      const sendButton = screen.getByLabelText('Send message')

      await user.type(textarea, '  Test message with spaces  ')
      await user.click(sendButton)

      await waitFor(() => {
        expect(mockChatStore.sendMessage).toHaveBeenCalledWith(
          'conv-1',
          'Test message with spaces',
          expect.any(String),
          expect.any(Object),
          [] // attachments
        )
      })
    })
  })

  describe('Store 集成测试', () => {
    it('should call loadData on mount', () => {
      render(<ChatInput />)

      expect(mockSettingsStore.loadData).toHaveBeenCalled()
    })
  })
})
