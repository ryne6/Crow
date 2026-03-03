/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ProviderConfigDialog } from '../ProviderConfigDialog'
import { OAUTH_API_KEY_PLACEHOLDER } from '~shared/constants/auth'

const mockDbClient = vi.hoisted(() => ({
  providers: {
    update: vi.fn(async () => ({})),
    oauthStatus: vi.fn(async () => ({
      authType: 'api_key',
      connected: false,
      hasAccessToken: false,
      hasRefreshToken: false,
      oauthProvider: null,
      accountEmail: null,
      expiresAt: null,
      isExpired: false,
    })),
    oauthImportOpenClaw: vi.fn(async () => ({})),
    oauthStartLogin: vi.fn(async () => ({
      sessionId: 'oauth-session-1',
      authUrl: 'https://auth.openai.com/oauth/authorize?mock=1',
      redirectUri: 'http://127.0.0.1:1455/oauth/callback',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    oauthGetLoginSession: vi.fn(async () => ({
      session: {
        sessionId: 'oauth-session-1',
        providerId: 'p1',
        status: 'succeeded',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        authUrl: 'https://auth.openai.com/oauth/authorize?mock=1',
        redirectUri: 'http://127.0.0.1:1455/oauth/callback',
        state: 'mock-state',
        codeVerifier: 'mock-code-verifier',
        codeChallenge: 'mock-code-challenge',
        authorizationCode: 'mock-code',
        error: null,
      },
      oauthStatus: {
        authType: 'oauth',
        connected: true,
        hasAccessToken: true,
        hasRefreshToken: true,
        oauthProvider: 'openai-codex',
        accountEmail: 'user@example.com',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        isExpired: false,
      },
    })),
    oauthCancelLogin: vi.fn(async () => ({})),
    oauthSetManual: vi.fn(async () => ({})),
    oauthLogout: vi.fn(async () => ({})),
    fetchModels: vi.fn(async () => ({
      providerId: 'p1',
      providerType: 'openai',
      dryRun: false,
      discovered: 2,
      filteredOut: 0,
      created: 2,
      updated: 0,
      unchanged: 0,
      toCreate: ['gpt-4o', 'gpt-4.1'],
      toUpdate: [],
      models: ['gpt-4o', 'gpt-4.1'],
    })),
  },
}))

const mockNotify = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  errorWithRetry: vi.fn(),
}))

const mockSettingsStore = vi.hoisted(() => ({
  triggerRefresh: vi.fn(),
}))

vi.mock('~/services/dbClient', () => ({
  dbClient: mockDbClient,
}))

vi.mock('~/utils/notify', () => ({
  notify: mockNotify,
}))

vi.mock('~/stores/settingsStore', () => ({
  useSettingsStore: () => mockSettingsStore,
}))

vi.mock('@lobehub/ui', () => {
  const React = require('react')
  return {
    Modal: ({ open, children, title }: any) =>
      open ? (
        <div role="dialog" aria-label={title}>
          <h2>{title}</h2>
          {children}
        </div>
      ) : null,
    Button: ({ children, htmlType, type, ...props }: any) => (
      <button type={htmlType ?? type} {...props}>
        {children}
      </button>
    ),
    Input: React.forwardRef(({ ...props }: any, ref: any) => (
      <input ref={ref} {...props} />
    )),
    Select: ({ id, value, onChange, options }: any) => (
      <select
        id={id}
        value={value}
        onChange={(e: any) => onChange(e.target.value)}
      >
        {options?.map((opt: any) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    ),
    Checkbox: ({ checked, onChange, children }: any) => (
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e: any) => onChange(e.target.checked)}
        />
        {children}
      </label>
    ),
  }
})

const mockProvider = {
  id: 'p1',
  name: 'OpenAI',
  type: 'openai',
  apiKey: 'sk-test',
  baseURL: 'https://api.openai.com/v1',
  apiFormat: 'chat-completions',
  authType: 'api_key',
  modelSyncOnlyCreate: false,
  modelSyncEnableNewModels: true,
  modelSyncNameFilter: null,
  enabled: true,
}

describe('ProviderConfigDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should allow editing name, apiFormat, enabled', () => {
    render(
      <ProviderConfigDialog
        provider={mockProvider}
        open
        onClose={vi.fn()}
        onUpdated={vi.fn()}
      />
    )

    expect(screen.getByLabelText(/^Name\s*\*/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/API Format/i)).toBeInTheDocument()
    // LobeUI Checkbox uses children as label text, not htmlFor
    expect(screen.getByText(/Enabled/i)).toBeInTheDocument()
  })

  it('should submit via form when clicking Save Changes', async () => {
    const user = (await import('@testing-library/user-event')).default.setup()
    const onClose = vi.fn()
    const onUpdated = vi.fn()

    render(
      <ProviderConfigDialog
        provider={mockProvider}
        open
        onClose={onClose}
        onUpdated={onUpdated}
      />
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('OpenAI')).toBeInTheDocument()
    })

    const saveButton = screen.getByRole('button', { name: /Save Changes/i })
    expect(saveButton).toHaveAttribute('type', 'submit')

    await user.click(saveButton)

    await waitFor(() => {
      expect(mockDbClient.providers.update).toHaveBeenCalled()
    })

    expect(onClose).toHaveBeenCalled()
    expect(onUpdated).toHaveBeenCalled()
  })

  it('should require real API key when placeholder key is present in api_key mode', async () => {
    const user = (await import('@testing-library/user-event')).default.setup()

    render(
      <ProviderConfigDialog
        provider={{
          ...mockProvider,
          authType: 'api_key',
          apiKey: OAUTH_API_KEY_PLACEHOLDER,
        }}
        open
        onClose={vi.fn()}
        onUpdated={vi.fn()}
      />
    )

    const apiKeyInput = screen.getByLabelText(/API Key/i) as HTMLInputElement
    expect(apiKeyInput.value).toBe('')

    const saveButton = screen.getByRole('button', { name: /Save Changes/i })
    await user.click(saveButton)

    await waitFor(() => {
      expect(mockDbClient.providers.update).not.toHaveBeenCalled()
    })
    expect(mockDbClient.providers.update).not.toHaveBeenCalled()
  })

  it('should start OAuth login flow', async () => {
    const user = (await import('@testing-library/user-event')).default.setup()
    const onUpdated = vi.fn()

    render(
      <ProviderConfigDialog
        provider={{ ...mockProvider, authType: 'oauth' }}
        open
        onClose={vi.fn()}
        onUpdated={onUpdated}
      />
    )

    const signInButton = await screen.findByRole('button', {
      name: /Sign in with ChatGPT/i,
    })
    await user.click(signInButton)

    await waitFor(() => {
      expect(mockDbClient.providers.oauthStartLogin).toHaveBeenCalledWith('p1')
    })

    await waitFor(() => {
      expect(mockDbClient.providers.oauthGetLoginSession).toHaveBeenCalled()
    })

    await waitFor(() => {
      expect(mockNotify.success).toHaveBeenCalledWith('OAuth login succeeded')
    })
    expect(onUpdated).toHaveBeenCalled()
  })

  it('should fetch models manually', async () => {
    const user = (await import('@testing-library/user-event')).default.setup()
    const onUpdated = vi.fn()

    render(
      <ProviderConfigDialog
        provider={{ ...mockProvider, authType: 'oauth' }}
        open
        onClose={vi.fn()}
        onUpdated={onUpdated}
      />
    )

    const fetchButton = await screen.findByRole('button', {
      name: /Fetch Models/i,
    })
    await user.click(fetchButton)

    await waitFor(() => {
      expect(mockDbClient.providers.fetchModels).toHaveBeenCalledWith('p1', {
        onlyCreateNew: false,
        enableNewModels: true,
        nameFilter: null,
      })
    })
    expect(onUpdated).toHaveBeenCalled()
  })

  it('should preview models without applying changes', async () => {
    const user = (await import('@testing-library/user-event')).default.setup()
    const onUpdated = vi.fn()

    render(
      <ProviderConfigDialog
        provider={{ ...mockProvider, authType: 'oauth' }}
        open
        onClose={vi.fn()}
        onUpdated={onUpdated}
      />
    )

    const previewButton = await screen.findByRole('button', {
      name: /Preview Sync/i,
    })
    await user.click(previewButton)

    await waitFor(() => {
      expect(mockDbClient.providers.fetchModels).toHaveBeenCalledWith('p1', {
        onlyCreateNew: false,
        enableNewModels: true,
        nameFilter: null,
        dryRun: true,
      })
    })
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it('should auto fetch models after oauth login when enabled', async () => {
    const user = (await import('@testing-library/user-event')).default.setup()

    render(
      <ProviderConfigDialog
        provider={{
          ...mockProvider,
          authType: 'oauth',
          oauthAutoFetchModels: true,
        }}
        open
        onClose={vi.fn()}
        onUpdated={vi.fn()}
      />
    )

    const signInButton = await screen.findByRole('button', {
      name: /Sign in with ChatGPT/i,
    })
    await user.click(signInButton)

    await waitFor(() => {
      expect(mockDbClient.providers.fetchModels).toHaveBeenCalledWith('p1', {
        onlyCreateNew: false,
        enableNewModels: true,
        nameFilter: null,
      })
    })
  })
})
