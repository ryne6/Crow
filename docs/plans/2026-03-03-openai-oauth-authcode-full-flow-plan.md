# Crow OpenAI OAuth Auth Code Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Crow 中实现完整 OpenAI OAuth 授权码流程（拉起浏览器 + localhost 回调 + code 换 token + refresh 持久化），并与现有 provider 配置与聊天请求链路无缝集成。

**Architecture:** 参考 OpenClaw 的 `openai-codex-oauth` + `oauth-flow` + `auth-profiles/oauth` 思路，在 Crow 主进程新增 OAuth 会话管理器，负责 PKCE/state、回调监听、code 交换 token、状态管理与超时清理。Renderer 通过 IPC 发起登录并轮询会话状态；成功后复用现有 `ProviderService` 加密持久化和 `resolveCredentials` 续期逻辑。

**Tech Stack:** Electron (`shell.openExternal`, `ipcMain`), Node `http` server (loopback callback), TypeScript, Drizzle/SQLite, React settings UI, Vitest.

## Scope and Non-goals

- Scope:
  - OpenAI provider 的完整 OAuth auth code + PKCE 登录。
  - 登录成功后写入并加密保存 `access_token/refresh_token/expires_at`。
  - 聊天前自动刷新即将过期 token（已有能力增强）。
  - 支持取消登录、登录超时、回调失败可视化。
- Non-goals:
  - 本阶段不做多 provider 通用 OAuth 框架（先 OpenAI 专用）。
  - 不替换现有 “Import OpenClaw / 手动 token” 功能（保留作为 fallback）。

## OpenClaw Mapping

- Browser + callback orchestration:
  - `/tmp/openclaw-repo/src/commands/openai-codex-oauth.ts`
  - `/tmp/openclaw-repo/src/commands/oauth-flow.ts`
- OAuth credential persist/refresh:
  - `/tmp/openclaw-repo/src/agents/auth-profiles/oauth.ts`
  - `/tmp/openclaw-repo/src/commands/onboard-auth.credentials.ts`

## Approach Options

1. 推荐: Loopback 回调 + PKCE（与 OpenClaw 框架一致）
  - 优点: 标准 OAuth 桌面应用做法，安全性和可维护性最好。
  - 缺点: 需要本地临时端口和会话状态管理。
2. 内嵌 BrowserWindow 拦截重定向
  - 优点: UI 可控。
  - 缺点: 登录兼容性和安全边界更复杂，不如系统浏览器稳定。
3. 设备码流程
  - 优点: 不依赖回调端口。
  - 缺点: 交互较慢；OpenClaw 当前核心路径不是此模式。

结论: 采用方案 1。

## Task 1: Add OAuth Runtime Config and Types

**Files:**
- Create: `/Users/x/Desktop/workspace/Crow/src/main/services/openAIOAuthConfig.ts`
- Modify: `/Users/x/Desktop/workspace/Crow/src/renderer/src/services/dbClient.ts`
- Modify: `/Users/x/Desktop/workspace/Crow/src/shared/types/ipc.ts`
- Test: `/Users/x/Desktop/workspace/Crow/src/main/services/__tests__/openAIOAuthConfig.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { resolveOpenAIOAuthConfig } from '../openAIOAuthConfig'

describe('resolveOpenAIOAuthConfig', () => {
  it('provides defaults for authorize/token/callback/scopes', () => {
    const cfg = resolveOpenAIOAuthConfig({})
    expect(cfg.authorizeEndpoint).toContain('/oauth/authorize')
    expect(cfg.tokenEndpoint).toContain('/oauth/token')
    expect(cfg.scopes).toContain('openid')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/services/__tests__/openAIOAuthConfig.test.ts`  
Expected: FAIL (`openAIOAuthConfig` not found)

**Step 3: Write minimal implementation**

- `resolveOpenAIOAuthConfig(env)` 输出:
  - `authorizeEndpoint` (default: `https://auth.openai.com/oauth/authorize`)
  - `tokenEndpoint` (default: `https://auth.openai.com/oauth/token`)
  - `userinfoEndpoint` (optional)
  - `clientId` (required at runtime start-login)
  - `scopes` (default: `openid profile email offline_access`)
  - `callbackHost` (default: `127.0.0.1`)
  - `callbackPath` (default: `/oauth/callback`)
  - `callbackPortCandidates` (default: `1455-1475`)

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/main/services/__tests__/openAIOAuthConfig.test.ts`  
Expected: PASS

## Task 2: Implement OAuth Session Manager (Browser + Loopback Callback)

**Files:**
- Create: `/Users/x/Desktop/workspace/Crow/src/main/services/openAIOAuthSessionService.ts`
- Test: `/Users/x/Desktop/workspace/Crow/src/main/services/__tests__/openAIOAuthSessionService.test.ts`

**Step 1: Write the failing tests**

关键测试:
- `startLogin()` 生成 `sessionId/state/codeVerifier/codeChallenge`。
- 成功绑定 loopback 端口并构造 `authUrl`。
- 回调 state 不匹配时会话进入 `failed`。
- 回调成功时会话进入 `code_received`。
- 会话超时自动清理。

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/services/__tests__/openAIOAuthSessionService.test.ts`  
Expected: FAIL

**Step 3: Write minimal implementation**

`openAIOAuthSessionService`:
- 内存状态 `Map<sessionId, OAuthLoginSession>`。
- `startLogin(providerId)`:
  - 生成 `sessionId/state/codeVerifier`。
  - 选择可用本地端口，启动 `http.createServer` 监听 `127.0.0.1`。
  - 构造 `redirect_uri` 和 `authUrl`。
  - 调用 `shell.openExternal(authUrl)` 拉起系统浏览器。
- `getSessionStatus(sessionId)` 返回 `pending/opened/code_received/exchanging/succeeded/failed/cancelled/timeout`。
- `cancelLogin(sessionId)` 关闭 server，标记取消。
- 回调处理:
  - 校验 path/state/error/code。
  - 给浏览器返回简短 HTML 提示“登录完成，可返回 Crow”。
  - 持久化 code 到 session，关闭 server。

**Step 4: Run tests**

Run: `npm run test -- src/main/services/__tests__/openAIOAuthSessionService.test.ts`  
Expected: PASS

## Task 3: Exchange Code for Token and Persist Encrypted Credentials

**Files:**
- Modify: `/Users/x/Desktop/workspace/Crow/src/main/services/openAIOAuthService.ts`
- Modify: `/Users/x/Desktop/workspace/Crow/src/main/db/services/providerService.ts`
- Test: `/Users/x/Desktop/workspace/Crow/src/main/services/__tests__/openAIOAuthService.test.ts`

**Step 1: Write failing tests**

关键测试:
- `completeLogin(sessionId)` 调 token endpoint，成功写入 provider OAuth 字段。
- response 中 refresh_token 缺失时保留旧 refresh_token（refresh 轮换兼容）。
- token endpoint 失败时会话状态变 `failed`，错误信息可读。
- 写库后 `ProviderService.getById` 取回的是解密 token。

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/services/__tests__/openAIOAuthService.test.ts`  
Expected: FAIL

**Step 3: Implement**

- `completeLogin(sessionId)`:
  - 从 session 取 `code + codeVerifier + redirectUri`。
  - `application/x-www-form-urlencoded` 调 token endpoint:
    - `grant_type=authorization_code`
    - `code`
    - `redirect_uri`
    - `client_id`
    - `code_verifier`
  - 解析 `access_token/refresh_token/expires_in/id_token`。
  - 计算 `oauthExpiresAt = now + expires_in`。
  - 调用 `ProviderService.setOAuthCredentials(...)` 加密持久化。
- account email 来源顺序:
  - userinfo endpoint（若配置）
  - `id_token` payload（仅解析，不校验签名，作为显示信息）
  - null

**Step 4: Run tests**

Run: `npm run test -- src/main/services/__tests__/openAIOAuthService.test.ts`  
Expected: PASS

## Task 4: Wire IPC Endpoints for OAuth Login State Machine

**Files:**
- Modify: `/Users/x/Desktop/workspace/Crow/src/main/index.ts`
- Modify: `/Users/x/Desktop/workspace/Crow/src/renderer/src/services/dbClient.ts`
- Modify: `/Users/x/Desktop/workspace/Crow/src/shared/types/ipc.ts`
- Test: `/Users/x/Desktop/workspace/Crow/src/renderer/src/services/__tests__/dbClient.oauth.test.ts`

**Step 1: Write failing tests**

新增方法 contract:
- `db:providers:oauthStartLogin`
- `db:providers:oauthGetLoginSession`
- `db:providers:oauthCancelLogin`

**Step 2: Run tests**

Run: `npm run test -- src/renderer/src/services/__tests__/dbClient.oauth.test.ts`  
Expected: FAIL

**Step 3: Implement**

主进程:
- `oauthStartLogin(id)` -> `{ sessionId, authUrl, redirectUri, expiresAt }`
- `oauthGetLoginSession({ sessionId })` -> 会话状态 + 错误 + provider status
- `oauthCancelLogin({ sessionId })`

Renderer:
- `dbClient.providers` 新增对应方法和 TS 类型。

**Step 4: Run tests**

Run: `npm run test -- src/renderer/src/services/__tests__/dbClient.oauth.test.ts`  
Expected: PASS

## Task 5: Update Provider Settings UI for Full OAuth Flow

**Files:**
- Modify: `/Users/x/Desktop/workspace/Crow/src/renderer/src/components/settings/ProviderConfigDialog.tsx`
- Test: `/Users/x/Desktop/workspace/Crow/src/renderer/src/components/settings/__tests__/ProviderConfigDialog.test.tsx`

**Step 1: Write failing tests**

关键测试:
- 点击 `Sign in with ChatGPT` 调用 `oauthStartLogin`。
- UI 开始轮询 `oauthGetLoginSession` 并展示状态文案（`Waiting browser / Exchanging token / Success / Failed`）。
- 登录成功后自动刷新 `oauthStatus` 并通知成功。
- 点击取消会触发 `oauthCancelLogin`。

**Step 2: Run tests**

Run: `npm run test -- src/renderer/src/components/settings/__tests__/ProviderConfigDialog.test.tsx`  
Expected: FAIL

**Step 3: Implement UI**

- 在 OAuth 区域新增主按钮: `Sign in with ChatGPT`。
- 登录进行中:
  - 显示 spinner + 当前状态
  - 显示 “Open browser manually” 链接（用 `authUrl`）
  - 显示 “Cancel login” 按钮
- 成功后:
  - 自动 `setFormData(authType='oauth')`
  - `loadOAuthStatus()` + `triggerRefresh()` + `onUpdated()`

**Step 4: Run tests**

Run: `npm run test -- src/renderer/src/components/settings/__tests__/ProviderConfigDialog.test.tsx`  
Expected: PASS

## Task 6: Harden Refresh and Concurrency Control

**Files:**
- Modify: `/Users/x/Desktop/workspace/Crow/src/main/services/openAIOAuthService.ts`
- Test: `/Users/x/Desktop/workspace/Crow/src/main/services/__tests__/openAIOAuthService.refresh.test.ts`

**Step 1: Write failing tests**

关键测试:
- 并发两次 `resolveProviderCredentials` 时只触发一次 refresh（singleflight）。
- refresh 返回新 refresh_token 时正确替换持久化。
- refresh `invalid_grant` 时返回可识别错误并提示重新登录。

**Step 2: Implement**

- 引入 per-provider refresh lock (`Map<providerId, Promise<string>>`)。
- 将过期阈值统一为 `expiresAt - 60s`（保留现逻辑）。
- 错误分类:
  - `needs_reauth`
  - `temporary_network_error`
  - `server_error`

**Step 3: Run tests**

Run: `npm run test -- src/main/services/__tests__/openAIOAuthService.refresh.test.ts`  
Expected: PASS

## Task 7: End-to-end Verification

**Files:**
- Modify: `/Users/x/Desktop/workspace/Crow/docs/plans/2026-03-03-openai-oauth-authcode-full-flow-plan.md` (记录结果)

**Step 1: Typecheck**

Run: `npm run typecheck`  
Expected: PASS

**Step 2: Targeted tests**

Run:
- `npm run test -- src/main/services/__tests__/openAIOAuthConfig.test.ts`
- `npm run test -- src/main/services/__tests__/openAIOAuthSessionService.test.ts`
- `npm run test -- src/main/services/__tests__/openAIOAuthService.test.ts`
- `npm run test -- src/renderer/src/components/settings/__tests__/ProviderConfigDialog.test.tsx`
- `npm run test -- src/renderer/src/services/__tests__/dbClient.oauth.test.ts`

Expected: PASS

**Step 3: Manual smoke**

- 打开设置 -> OpenAI Provider -> 切到 OAuth 模式 -> `Sign in with ChatGPT`。
- 浏览器授权后自动返回 Crow，状态显示 Connected。
- 发送一条消息验证真实调用成功。
- 手动将 `oauthExpiresAt` 改为过去时间，发送消息触发 refresh 成功。

## Security Checklist

- `state` 必须校验且一次性消费。
- `code_verifier` 仅驻留内存，登录结束即删除。
- 回调监听仅 `127.0.0.1`。
- token 永不写日志，错误日志做脱敏（仅尾部 4 位）。
- 回调端口释放和超时回收必须在 `finally` 完成。

## Rollout Plan

1. 先在开发版开启（可通过 `OPENAI_OAUTH_ENABLE_FULL_FLOW=true` 控制）。
2. 保留 Import/Manual fallback 两周。
3. 观察 token refresh 失败率与登录完成率，再决定是否默认折叠 fallback 区域。

## Ready-to-Implement Checklist

- [ ] OAuth config defaults and env contract 固化
- [ ] 会话状态机 + loopback callback 可用
- [ ] code->token 持久化链路通过
- [ ] renderer 设置页完成登录可视化
- [ ] 并发 refresh 锁与错误分类可用
- [ ] 单测 + typecheck + 手工验证通过

