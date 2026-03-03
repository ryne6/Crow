import { describe, it, expect, beforeEach, vi } from 'vitest'
import chatApp from '../chat'
import { AIManager } from '../../services/ai/manager'
import { ProviderValidator } from '../../services/ai/validator'
import { AIError } from '../../services/ai/errors'
import { ErrorCode } from '../../../shared/types/error'
import type {
  AIMessage,
  AIConfig,
  AIStreamChunk,
} from '../../../shared/types/ai'

// Mock AI Manager
vi.mock('../../services/ai/manager')
vi.mock('../../services/ai/validator')

describe('Chat Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('POST /chat/stream', () => {
    it('should handle streaming chat request successfully', async () => {
      const mockMessages: AIMessage[] = [{ role: 'user', content: 'Hello' }]
      const mockConfig: AIConfig = {
        apiKey: 'test-key',
        model: 'test-model',
      }

      const mockChunks: AIStreamChunk[] = [
        { content: 'Hello ', done: false },
        { content: 'there!', done: true },
      ]

      // Mock AIManager.sendMessage to call onChunk callback
      vi.mocked(AIManager.prototype.sendMessage).mockImplementation(
        async (provider, messages, config, onChunk) => {
          if (onChunk) {
            for (const chunk of mockChunks) {
              await onChunk(chunk)
            }
          }
          return 'Hello there!'
        }
      )

      const res = await chatApp.request('/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: mockMessages,
          config: mockConfig,
        }),
      })

      expect(res.status).toBe(200)
      expect(AIManager.prototype.sendMessage).toHaveBeenCalledWith(
        'openai',
        mockMessages,
        mockConfig,
        expect.any(Function),
        expect.objectContaining({
          toolPermissions: undefined,
          allowOnceTools: undefined,
        })
      )
    })

    it('should handle missing provider parameter', async () => {
      // Current implementation validates required params and returns 400
      const res = await chatApp.request('/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          config: { apiKey: 'test', model: 'test' },
        }),
      })

      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBeDefined()
      expect(data.error.code).toBe(ErrorCode.INVALID_REQUEST)
    })

    it('should handle missing messages parameter', async () => {
      const res = await chatApp.request('/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          config: { apiKey: 'test', model: 'test' },
        }),
      })

      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe(ErrorCode.INVALID_REQUEST)
    })

    it('should handle missing config parameter', async () => {
      const res = await chatApp.request('/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      })

      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe(ErrorCode.INVALID_REQUEST)
    })

    it('should handle invalid JSON body', async () => {
      const res = await chatApp.request('/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      })

      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBeDefined()
    })

    it('should handle AI manager errors in stream', async () => {
      vi.mocked(AIManager.prototype.sendMessage).mockRejectedValue(
        new Error('AI service error')
      )

      const res = await chatApp.request('/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: 'Hello' }],
          config: { apiKey: 'test', model: 'test' },
        }),
      })

      expect(res.status).toBe(200)
      // Stream should contain error message
      const text = await res.text()
      expect(text).toContain('error')
      expect(text).toContain('AI service error')
    })
  })

  describe('POST /chat', () => {
    it('should handle non-streaming chat request successfully', async () => {
      const mockMessages: AIMessage[] = [{ role: 'user', content: 'Hello' }]
      const mockConfig: AIConfig = {
        apiKey: 'test-key',
        model: 'test-model',
      }

      vi.mocked(AIManager.prototype.sendMessage).mockResolvedValue(
        'Hello! How can I help you?'
      )

      const res = await chatApp.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: mockMessages,
          config: mockConfig,
        }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual({
        content: 'Hello! How can I help you?',
      })
      expect(AIManager.prototype.sendMessage).toHaveBeenCalledWith(
        'openai',
        mockMessages,
        mockConfig,
        undefined,
        expect.objectContaining({
          toolPermissions: undefined,
          allowOnceTools: undefined,
        })
      )
    })

    it('should pass webSearchEngine into AI request options', async () => {
      const mockMessages: AIMessage[] = [{ role: 'user', content: 'Search web' }]
      const mockConfig: AIConfig = {
        apiKey: 'test-key',
        model: 'test-model',
      }

      vi.mocked(AIManager.prototype.sendMessage).mockResolvedValue('done')

      const res = await chatApp.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: mockMessages,
          config: mockConfig,
          webSearchEngine: 'bing',
        }),
      })

      expect(res.status).toBe(200)
      expect(AIManager.prototype.sendMessage).toHaveBeenCalledWith(
        'openai',
        mockMessages,
        mockConfig,
        undefined,
        expect.objectContaining({
          webSearchEngine: 'bing',
        })
      )
    })

    it('should handle AI manager errors', async () => {
      vi.mocked(AIManager.prototype.sendMessage).mockRejectedValue(
        new Error('API key invalid')
      )

      const res = await chatApp.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: 'Hello' }],
          config: { apiKey: 'invalid', model: 'test' },
        }),
      })

      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBeDefined()
      expect(data.error.message).toBe('API key invalid')
    })

    it('should handle invalid request body', async () => {
      const res = await chatApp.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })

      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data).toHaveProperty('error')
    })
  })

  describe('GET /providers', () => {
    it('should return list of available providers', async () => {
      const mockProviders = ['claude', 'openai', 'gemini', 'deepseek']
      vi.mocked(AIManager.prototype.getAvailableProviders).mockReturnValue(
        mockProviders
      )

      const res = await chatApp.request('/providers')

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual({ providers: mockProviders })
    })

    it('should handle errors when getting providers', async () => {
      vi.mocked(AIManager.prototype.getAvailableProviders).mockImplementation(
        () => {
          throw new Error('Failed to get providers')
        }
      )

      const res = await chatApp.request('/providers')

      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBeDefined()
      expect(data.error.message).toBe('Failed to get providers')
    })
  })

  describe('GET /providers/:provider/default-model', () => {
    it('should return default model for provider', async () => {
      vi.mocked(AIManager.prototype.getDefaultModel).mockReturnValue('gpt-4')

      const res = await chatApp.request('/providers/openai/default-model')

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual({ defaultModel: 'gpt-4' })
      expect(AIManager.prototype.getDefaultModel).toHaveBeenCalledWith('openai')
    })

    it('should handle unknown provider', async () => {
      vi.mocked(AIManager.prototype.getDefaultModel).mockImplementation(() => {
        throw new Error('Unknown provider type: unknown')
      })

      const res = await chatApp.request('/providers/unknown/default-model')

      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data).toHaveProperty('error')
    })
  })

  describe('GET /providers/:provider/models', () => {
    it('should return supported models for provider', async () => {
      const mockModels = ['gpt-4', 'gpt-3.5-turbo', 'gpt-4-turbo']
      vi.mocked(AIManager.prototype.getSupportedModels).mockReturnValue(
        mockModels
      )

      const res = await chatApp.request('/providers/openai/models')

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual({ models: mockModels })
      expect(AIManager.prototype.getSupportedModels).toHaveBeenCalledWith(
        'openai'
      )
    })

    it('should handle errors when getting models', async () => {
      vi.mocked(AIManager.prototype.getSupportedModels).mockImplementation(
        () => {
          throw new Error('Provider not found')
        }
      )

      const res = await chatApp.request('/providers/invalid/models')

      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data).toHaveProperty('error')
    })
  })

  describe('POST /providers/validate', () => {
    it('should validate provider configuration successfully', async () => {
      vi.mocked(ProviderValidator.validateProvider).mockResolvedValue({
        valid: true,
      })

      const res = await chatApp.request('/providers/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          config: { apiKey: 'valid-key', model: 'gpt-4' },
        }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual({ valid: true })
    })

    it('should return validation error for invalid config', async () => {
      vi.mocked(ProviderValidator.validateProvider).mockResolvedValue({
        valid: false,
        error: 'Invalid API key',
      })

      const res = await chatApp.request('/providers/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          config: { apiKey: 'invalid-key', model: 'gpt-4' },
        }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual({
        valid: false,
        error: 'Invalid API key',
      })
    })

    it('should handle validation errors', async () => {
      vi.mocked(ProviderValidator.validateProvider).mockRejectedValue(
        new Error('Network error')
      )

      const res = await chatApp.request('/providers/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          config: { apiKey: 'test', model: 'gpt-4' },
        }),
      })

      // Network errors are mapped to 503
      expect(res.status).toBe(503)
      const data = await res.json()
      expect(data.valid).toBe(false)
      expect(data.error).toBeDefined()
    })

    it('should handle invalid request body', async () => {
      const res = await chatApp.request('/providers/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid',
      })

      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data).toHaveProperty('valid', false)
      expect(data).toHaveProperty('error')
    })

    it('should return 400 when provider is missing', async () => {
      const res = await chatApp.request('/providers/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { apiKey: 'test', model: 'gpt-4' },
        }),
      })

      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.valid).toBe(false)
      expect(data.error).toBeDefined()
    })

    it('should return 400 when config is missing', async () => {
      const res = await chatApp.request('/providers/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
        }),
      })

      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.valid).toBe(false)
    })
  })

  describe('Error Mapping', () => {
    it('should map network errors to 503 status', async () => {
      const networkError = new Error('fetch failed')
      vi.mocked(AIManager.prototype.sendMessage).mockRejectedValue(networkError)

      const res = await chatApp.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: 'Hello' }],
          config: { apiKey: 'test', model: 'test' },
        }),
      })

      expect(res.status).toBe(503)
      const data = await res.json()
      expect(data.error.code).toBe(ErrorCode.NETWORK_ERROR)
      expect(data.error.retryable).toBe(true)
    })

    it('should map timeout errors to 504 status', async () => {
      const timeoutError = new Error('Request timeout')
      vi.mocked(AIManager.prototype.sendMessage).mockRejectedValue(timeoutError)

      const res = await chatApp.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: 'Hello' }],
          config: { apiKey: 'test', model: 'test' },
        }),
      })

      expect(res.status).toBe(504)
      const data = await res.json()
      expect(data.error.code).toBe(ErrorCode.TIMEOUT)
    })

    it('should preserve AIError properties through error response', async () => {
      const aiError = new AIError(
        ErrorCode.RATE_LIMITED,
        'Rate limit exceeded',
        {
          retryAfter: 60,
          details: { limit: 100, remaining: 0 },
        }
      )
      vi.mocked(AIManager.prototype.sendMessage).mockRejectedValue(aiError)

      const res = await chatApp.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: 'Hello' }],
          config: { apiKey: 'test', model: 'test' },
        }),
      })

      expect(res.status).toBe(429)
      const data = await res.json()
      expect(data.error.code).toBe(ErrorCode.RATE_LIMITED)
      expect(data.error.retryAfter).toBe(60)
      expect(data.error.retryable).toBe(true)
    })

    it('should map unauthorized errors to 401', async () => {
      const aiError = new AIError(ErrorCode.UNAUTHORIZED, 'Invalid API key')
      vi.mocked(AIManager.prototype.sendMessage).mockRejectedValue(aiError)

      const res = await chatApp.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: 'Hello' }],
          config: { apiKey: 'invalid', model: 'test' },
        }),
      })

      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error.code).toBe(ErrorCode.UNAUTHORIZED)
      expect(data.error.retryable).toBe(false)
    })

    it('should map provider errors to 502', async () => {
      const aiError = new AIError(
        ErrorCode.PROVIDER_ERROR,
        'Provider service unavailable'
      )
      vi.mocked(AIManager.prototype.sendMessage).mockRejectedValue(aiError)

      const res = await chatApp.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: 'Hello' }],
          config: { apiKey: 'test', model: 'test' },
        }),
      })

      expect(res.status).toBe(502)
      const data = await res.json()
      expect(data.error.code).toBe(ErrorCode.PROVIDER_ERROR)
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty messages array', async () => {
      vi.mocked(AIManager.prototype.sendMessage).mockResolvedValue('')

      const res = await chatApp.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [],
          config: { apiKey: 'test', model: 'test' },
        }),
      })

      // Should still succeed with empty messages
      expect(res.status).toBe(200)
    })

    it('should handle very long message content', async () => {
      const longContent = 'x'.repeat(100000)
      vi.mocked(AIManager.prototype.sendMessage).mockResolvedValue('Response')

      const res = await chatApp.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: longContent }],
          config: { apiKey: 'test', model: 'test' },
        }),
      })

      expect(res.status).toBe(200)
      expect(AIManager.prototype.sendMessage).toHaveBeenCalledWith(
        'openai',
        [{ role: 'user', content: longContent }],
        expect.any(Object),
        undefined,
        expect.objectContaining({
          toolPermissions: undefined,
          allowOnceTools: undefined,
        })
      )
    })

    it('should handle special characters in message content', async () => {
      const specialContent = '你好！こんにちは 🎉 <script>alert("xss")</script>'
      vi.mocked(AIManager.prototype.sendMessage).mockResolvedValue('Response')

      const res = await chatApp.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: specialContent }],
          config: { apiKey: 'test', model: 'test' },
        }),
      })

      expect(res.status).toBe(200)
    })

    it('should handle multiple messages in conversation', async () => {
      const messages: AIMessage[] = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ]
      vi.mocked(AIManager.prototype.sendMessage).mockResolvedValue(
        'I am doing well!'
      )

      const res = await chatApp.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages,
          config: { apiKey: 'test', model: 'test' },
        }),
      })

      expect(res.status).toBe(200)
      expect(AIManager.prototype.sendMessage).toHaveBeenCalledWith(
        'openai',
        messages,
        expect.any(Object),
        undefined,
        expect.objectContaining({
          toolPermissions: undefined,
          allowOnceTools: undefined,
        })
      )
    })

    it('should handle tool use chunks in stream', async () => {
      const toolChunk: AIStreamChunk = {
        type: 'tool_use',
        toolUse: {
          id: 'tool_123',
          name: 'read_file',
          input: { path: '/test.txt' },
        },
      }

      vi.mocked(AIManager.prototype.sendMessage).mockImplementation(
        async (provider, messages, config, onChunk) => {
          if (onChunk) {
            await onChunk(toolChunk)
            await onChunk({ type: 'done', done: true })
          }
          return ''
        }
      )

      const res = await chatApp.request('/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: 'Read file' }],
          config: { apiKey: 'test', model: 'test' },
        }),
      })

      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain('tool_use')
      expect(text).toContain('read_file')
    })

    it('should handle config with all optional parameters', async () => {
      const fullConfig: AIConfig = {
        apiKey: 'test-key',
        model: 'gpt-4',
        maxTokens: 2048,
        temperature: 0.8,
        baseURL: 'https://custom.api.com',
        systemPrompt: 'You are a coding assistant',
      }

      vi.mocked(AIManager.prototype.sendMessage).mockResolvedValue('Response')

      const res = await chatApp.request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: 'Hello' }],
          config: fullConfig,
        }),
      })

      expect(res.status).toBe(200)
      expect(AIManager.prototype.sendMessage).toHaveBeenCalledWith(
        'openai',
        expect.any(Array),
        fullConfig,
        undefined,
        expect.objectContaining({
          toolPermissions: undefined,
          allowOnceTools: undefined,
        })
      )
    })
  })
})
