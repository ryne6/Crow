import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { FileSystemService } from './services/fileSystemService'
import { GitService } from './services/gitService'
import { WebBrowserService } from './services/webBrowserService'

const app = new Hono()
const fsService = new FileSystemService()
const gitService = new GitService()
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Internal server error'

// CORS for local API access
app.use(
  '*',
  cors({
    origin: ['http://localhost:3000'],
    credentials: true,
  })
)

// Health check
app.get('/health', c => {
  return c.json({ status: 'ok' })
})

// IPC bridge endpoint
app.post('/ipc/:channel', async c => {
  const channel = c.req.param('channel')
  const body = await c.req.json()

  try {
    let result: Record<string, unknown> | { output: string; error?: string }

    switch (channel) {
      case 'fs:readFile':
        result = { content: await fsService.readFile(body.path) }
        break

      case 'fs:writeFile':
        result = { success: await fsService.writeFile(body.path, body.content) }
        break

      case 'fs:editFile':
        result = {
          replaced: await fsService.editFile(
            body.path,
            body.oldText,
            body.newText,
            body.replaceAll
          ),
        }
        break

      case 'fs:glob':
        result = { files: await fsService.glob(body.pattern, body.path) }
        break

      case 'fs:grep':
        result = {
          results: await fsService.grep(body.pattern, body.path, {
            glob: body.glob,
            ignoreCase: body.ignoreCase,
            maxResults: body.maxResults,
          }),
        }
        break

      case 'fs:listFiles':
        result = { files: await fsService.listFiles(body.path, body.pattern) }
        break

      case 'fs:exists':
        result = { exists: await fsService.exists(body.path) }
        break

      case 'fs:mkdir':
        result = { success: await fsService.mkdir(body.path) }
        break

      case 'exec:command':
        result = await fsService.executeCommand(body.command, body.cwd)
        break

      case 'git:status':
        result = await gitService.status(body.path)
        break

      case 'git:diff':
        result = await gitService.diff(body.path, body.staged, body.file)
        break

      case 'git:log':
        result = await gitService.log(body.path, body.maxCount)
        break

      case 'git:commit':
        result = await gitService.commit(body.path, body.message, body.files)
        break

      case 'git:push':
        result = await gitService.push(body.path, body.remote, body.branch)
        break

      case 'git:checkout':
        result = await gitService.checkout(body.path, body.branch, body.create)
        break

      case 'web:fetch':
        result = { content: await WebBrowserService.fetch(body.url, body.maxLength) }
        break

      case 'web:search':
        result = {
          results: await WebBrowserService.search(body.query, {
            engine: body.engine,
            limit: body.limit,
            recencyDays: body.recencyDays,
            domains: body.domains,
          }),
        }
        break

      case 'web:openLogin':
        await WebBrowserService.openLoginWindow(body.engine || 'google')
        result = { success: true }
        break

      case 'web:sessionStatus':
        result = { status: await WebBrowserService.getSessionStatus() }
        break

      case 'web:clearSession':
        await WebBrowserService.clearSession()
        result = { success: true }
        break

      case 'workspace:get':
        result = { path: fsService.getWorkspace() }
        break

      case 'workspace:set':
        result = { success: fsService.setWorkspace(body.path) }
        break

      default:
        return c.json({ error: `Unknown channel: ${channel}` }, 400)
    }

    return c.json(result)
  } catch (error: unknown) {
    console.error(`[IPC Bridge] Error on ${channel}:`, error)
    return c.json({ error: getErrorMessage(error) }, 500)
  }
})

export function startIpcBridge(port = 3001): void {
  console.log(`🔗 Starting IPC Bridge on port ${port}...`)

  serve({ fetch: app.fetch, port }, info => {
    console.log(`✅ IPC Bridge running at http://localhost:${info.port}`)
  })
}

export { fsService }
