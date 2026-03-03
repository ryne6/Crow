import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ToolExecutor } from '../executor'
import axios from 'axios'
import { TOOL_PERMISSION_PREFIX } from '~shared/types/toolPermissions'

// Mock axios
vi.mock('axios')

describe('ToolExecutor', () => {
  let executor: ToolExecutor

  beforeEach(() => {
    vi.clearAllMocks()
    executor = new ToolExecutor()
  })

  describe('execute', () => {
    it('should return permission request for dangerous tool when not allowed', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { output: 'ok' },
      })

      const result = await executor.execute(
        'Bash',
        { command: 'rm -rf /tmp/test' },
        { toolCallId: 'tc-1', toolPermissions: { allowAll: false } }
      )

      expect(result.startsWith(TOOL_PERMISSION_PREFIX)).toBe(true)
      expect(axios.post).not.toHaveBeenCalled()
    })

    it('should allow dangerous tool when allowOnceTools includes name', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { output: 'ok' },
      })

      await executor.execute(
        'Bash',
        { command: 'ls' },
        { toolCallId: 'tc-1', allowOnceTools: ['Bash'] }
      )

      expect(axios.post).toHaveBeenCalled()
    })

    it('should route to readFile for Read tool', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { content: 'file content' },
      })

      const result = await executor.execute('Read', {
        path: '~main/test/file.txt',
      })

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/fs:readFile',
        { path: '~main/test/file.txt' }
      )
      expect(result).toBe('file content')
    })

    it('should route to writeFile for Write tool', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { success: true },
      })

      const result = await executor.execute(
        'Write',
        {
          path: '~main/test/file.txt',
          content: 'new content',
        },
        { toolPermissions: { allowAll: true } }
      )

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/fs:writeFile',
        { path: '~main/test/file.txt', content: 'new content' }
      )
      expect(result).toContain('Successfully wrote')
    })

    it('should route to listFiles for LS tool', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          files: [
            { name: 'file1.txt', isDirectory: false, size: 1024 },
            { name: 'dir1', isDirectory: true, size: 0 },
          ],
        },
      })

      const result = await executor.execute('LS', { path: '~main/test' })

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/fs:listFiles',
        { path: '~main/test', pattern: undefined }
      )
      expect(result).toContain('Contents of /test')
    })

    it('should route to executeCommand for Bash tool', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { output: 'command output', error: '' },
      })

      const result = await executor.execute(
        'Bash',
        {
          command: 'npm test',
          cwd: '~main/test',
        },
        { toolPermissions: { allowAll: true } }
      )

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/exec:command',
        { command: 'npm test', cwd: '~main/test' }
      )
      expect(result).toContain('Command: npm test')
    })

    it('should route to editFile for Edit tool', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { replaced: 2 },
      })

      const result = await executor.execute(
        'Edit',
        {
          path: '~main/test/file.txt',
          old_text: 'old',
          new_text: 'new',
          replace_all: true,
        },
        { toolPermissions: { allowAll: true } }
      )

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/fs:editFile',
        {
          path: '~main/test/file.txt',
          oldText: 'old',
          newText: 'new',
          replaceAll: true,
        }
      )
      expect(result).toContain('Replaced 2 occurrence')
    })

    it('should return markdown list for TodoWrite tool', async () => {
      const result = await executor.execute('TodoWrite', {
        todos: [
          { id: '1', title: 'Do thing', status: 'todo' },
          {
            id: '2',
            title: 'In progress',
            status: 'in_progress',
            notes: 'Working on it',
          },
          { id: '3', title: 'Done', status: 'done' },
        ],
      })

      expect(result).toContain('- [ ] Do thing')
      expect(result).toContain('- [~] In progress')
      expect(result).toContain('- [x] Done')
      expect(result).toContain('  - Working on it')
    })

    it('should route to fs:glob for Glob tool', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { files: ['~main/test/a.ts', '~main/test/b.ts'] },
      })

      const result = await executor.execute('Glob', {
        pattern: '**/*.ts',
        path: '~main/test',
      })

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/fs:glob',
        { pattern: '**/*.ts', path: '~main/test' }
      )
      expect(result).toContain('~main/test/a.ts')
      expect(result).toContain('~main/test/b.ts')
    })

    it('should route to fs:grep for Grep tool', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          results: [
            { file: '~main/test/a.ts', line: 12, content: 'const a = 1' },
          ],
        },
      })

      const result = await executor.execute('Grep', {
        pattern: 'const',
        path: '~main/test',
      })

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/fs:grep',
        {
          pattern: 'const',
          path: '~main/test',
          glob: undefined,
          ignoreCase: undefined,
          maxResults: undefined,
        }
      )
      expect(result).toContain('~main/test/a.ts:12 const a = 1')
    })

    it('should route to git:status for GitStatus tool', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { output: 'On branch main' },
      })

      const result = await executor.execute('GitStatus', { path: '~main/repo' })

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/git:status',
        { path: '~main/repo' }
      )
      expect(result).toContain('On branch main')
    })

    it('should route to web:fetch for WebFetch tool', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { content: 'Example content' },
      })

      const result = await executor.execute('WebFetch', {
        url: 'https://example.com',
      })

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/web:fetch',
        { url: 'https://example.com', maxLength: undefined }
      )
      expect(result).toContain('Example content')
    })

    it('should route to web:search for WebSearch tool', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          results: [
            { title: 'Result', url: 'https://example.com', snippet: 'Snippet' },
          ],
        },
      })

      const result = await executor.execute('WebSearch', { query: 'test' })

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/web:search',
        {
          query: 'test',
          limit: undefined,
          recencyDays: undefined,
          domains: undefined,
        }
      )
      expect(result).toContain('1. Result')
      expect(result).toContain('https://example.com')
      expect(result).toContain('Snippet')
    })

    it('should pass engine when WebSearch input specifies it', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          results: [{ title: 'Result', url: 'https://example.com' }],
        },
      })

      await executor.execute('WebSearch', {
        query: 'test',
        engine: 'bing',
      })

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/web:search',
        {
          query: 'test',
          limit: undefined,
          recencyDays: undefined,
          domains: undefined,
          engine: 'bing',
        }
      )
    })

    it('should return permission request for unknown tool (classified as moderate)', async () => {
      const result = await executor.execute('unknown_tool', {})
      // Unknown tools are classified as 'moderate' by the permission engine
      expect(result.startsWith(TOOL_PERMISSION_PREFIX)).toBe(true)
    })

    it('should return error for unknown tool when allowAll is true', async () => {
      const result = await executor.execute(
        'unknown_tool',
        {},
        { toolPermissions: { allowAll: true } }
      )
      expect(result).toContain('Error: Unknown tool: unknown_tool')
    })

    it('should handle readFile errors gracefully', async () => {
      vi.mocked(axios.post).mockRejectedValue({
        response: { data: { error: 'File not found' } },
      })

      const result = await executor.execute('Read', {
        path: '~main/nonexistent.txt',
      })
      expect(result).toContain('Error: Failed to read file')
    })
  })

  describe('Read', () => {
    it('should read file content successfully', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { content: 'const x = 1;' },
      })

      const result = await executor.execute('Read', {
        path: '~main/src/index.ts',
      })
      expect(result).toBe('const x = 1;')
    })

    it('should handle network errors', async () => {
      vi.mocked(axios.post).mockRejectedValue(new Error('Network error'))

      const result = await executor.execute('Read', { path: '~main/test.txt' })
      expect(result).toContain('Error: Failed to read file')
      expect(result).toContain('Network error')
    })

    it('should handle API errors with response data', async () => {
      vi.mocked(axios.post).mockRejectedValue({
        response: { data: { error: 'Permission denied' } },
      })

      const result = await executor.execute('Read', {
        path: '~main/etc/passwd',
      })
      expect(result).toContain('Permission denied')
    })
  })

  describe('Write', () => {
    it('should write file content successfully', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { success: true },
      })

      const content = 'Hello, World!'
      const result = await executor.execute(
        'Write',
        {
          path: '~main/test/output.txt',
          content,
        },
        { toolPermissions: { allowAll: true } }
      )

      expect(result).toContain(
        `Successfully wrote ${content.length} characters`
      )
      expect(result).toContain('~main/test/output.txt')
    })

    it('should handle write failure', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { success: false },
      })

      const result = await executor.execute(
        'Write',
        {
          path: '~main/readonly/file.txt',
          content: 'test',
        },
        { toolPermissions: { allowAll: true } }
      )

      expect(result).toContain('Error: Failed to write file')
    })

    it('should handle network errors during write', async () => {
      vi.mocked(axios.post).mockRejectedValue(new Error('Connection refused'))

      const result = await executor.execute(
        'Write',
        {
          path: '~main/test.txt',
          content: 'test',
        },
        { toolPermissions: { allowAll: true } }
      )

      expect(result).toContain('Error: Failed to write file')
    })
  })

  describe('LS', () => {
    it('should list files with proper formatting', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          files: [
            { name: 'file1.txt', isDirectory: false, size: 500 },
            { name: 'file2.js', isDirectory: false, size: 2048 },
            { name: 'subdir', isDirectory: true, size: 0 },
          ],
        },
      })

      const result = await executor.execute('LS', { path: '~main/project' })

      expect(result).toContain('[FILE] file1.txt')
      expect(result).toContain('[FILE] file2.js')
      expect(result).toContain('[DIR] subdir')
      expect(result).toContain('500B')
      expect(result).toContain('2.0KB')
    })

    it('should handle empty directory', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { files: [] },
      })

      const result = await executor.execute('LS', { path: '~main/empty' })

      expect(result).toContain('is empty')
    })

    it('should pass pattern parameter', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { files: [{ name: 'test.ts', isDirectory: false, size: 100 }] },
      })

      await executor.execute('LS', { path: '~main/src', pattern: '*.ts' })

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/fs:listFiles',
        { path: '~main/src', pattern: '*.ts' }
      )
    })

    it('should format file sizes correctly', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          files: [
            { name: 'small.txt', isDirectory: false, size: 100 },
            { name: 'medium.txt', isDirectory: false, size: 1024 * 10 },
            { name: 'large.txt', isDirectory: false, size: 1024 * 1024 * 2 },
          ],
        },
      })

      const result = await executor.execute('LS', { path: '~main/test' })

      expect(result).toContain('100B')
      expect(result).toContain('10.0KB')
      expect(result).toContain('2.0MB')
    })
  })

  describe('Bash', () => {
    it('should execute command successfully', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          output: 'Test passed',
          error: '',
        },
      })

      const result = await executor.execute(
        'Bash',
        {
          command: 'npm test',
          cwd: '~main/project',
        },
        { toolPermissions: { allowAll: true } }
      )

      expect(result).toContain('Command: npm test')
      expect(result).toContain('Test passed')
    })

    it('should handle command with error output', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          output: '',
          error: 'Warning: deprecated package',
        },
      })

      const result = await executor.execute(
        'Bash',
        {
          command: 'npm install',
        },
        { toolPermissions: { allowAll: true } }
      )

      expect(result).toContain('Error/Warning')
      expect(result).toContain('deprecated package')
    })

    it('should handle command without cwd', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { output: 'output', error: '' },
      })

      await executor.execute(
        'Bash',
        { command: 'pwd' },
        { toolPermissions: { allowAll: true } }
      )

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/exec:command',
        { command: 'pwd', cwd: undefined }
      )
    })

    it('should handle command execution failure', async () => {
      vi.mocked(axios.post).mockRejectedValue({
        response: { data: { error: 'Command not found' } },
      })

      const result = await executor.execute(
        'Bash',
        {
          command: 'unknown_command',
        },
        { toolPermissions: { allowAll: true } }
      )

      expect(result).toContain('Error: Failed to execute command')
    })
  })

  describe('error handling', () => {
    it('should return generic error message for non-Error throws', async () => {
      vi.mocked(axios.post).mockRejectedValue('string error')

      const result = await executor.execute('Read', { path: '~main/test.txt' })
      expect(result).toContain('Error:')
    })

    it('should not crash on undefined input', async () => {
      const result = await executor.execute('Read', undefined)
      expect(result).toContain('Error')
    })
  })

  describe('TodoWrite edge cases', () => {
    it('should throw on null todos', async () => {
      const result = await executor.execute('TodoWrite', { todos: null })
      expect(result).toContain('Error: Todos must be provided as an array')
    })

    it('should throw on missing todos key', async () => {
      const result = await executor.execute('TodoWrite', {})
      expect(result).toContain('Error: Todos must be provided as an array')
    })

    it('should throw on non-array todos', async () => {
      const result = await executor.execute('TodoWrite', { todos: 'not-array' })
      expect(result).toContain('Error: Todos must be provided as an array')
    })

    it('should handle empty array', async () => {
      const result = await executor.execute('TodoWrite', { todos: [] })
      expect(result).toBe('')
    })

    it('should throw on invalid status', async () => {
      const result = await executor.execute('TodoWrite', {
        todos: [{ title: 'Test', status: 'invalid_status' }],
      })
      expect(result).toContain('Error: Invalid todo status: invalid_status')
    })

    it('should handle missing title gracefully', async () => {
      const result = await executor.execute('TodoWrite', {
        todos: [{ status: 'todo' }],
      })
      expect(result).toBe('- [ ] ')
    })

    it('should ignore empty string notes', async () => {
      const result = await executor.execute('TodoWrite', {
        todos: [{ title: 'Task', status: 'done', notes: '' }],
      })
      expect(result).toBe('- [x] Task')
      expect(result).not.toContain('  - ')
    })

    it('should ignore whitespace-only notes', async () => {
      const result = await executor.execute('TodoWrite', {
        todos: [{ title: 'Task', status: 'todo', notes: '   ' }],
      })
      expect(result).toBe('- [ ] Task')
      expect(result).not.toContain('  - ')
    })

    it('should trim notes content', async () => {
      const result = await executor.execute('TodoWrite', {
        todos: [
          { title: 'Task', status: 'in_progress', notes: '  padded note  ' },
        ],
      })
      expect(result).toContain('  - padded note')
      expect(result).not.toContain('  padded note  ')
    })
  })

  describe('LS formatSize boundaries', () => {
    it('should show bytes for exactly 1023', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          files: [{ name: 'f.txt', isDirectory: false, size: 1023 }],
        },
      })

      const result = await executor.execute('LS', { path: '~main/test' })
      expect(result).toContain('1023B')
    })

    it('should show KB for exactly 1024', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          files: [{ name: 'f.txt', isDirectory: false, size: 1024 }],
        },
      })

      const result = await executor.execute('LS', { path: '~main/test' })
      expect(result).toContain('1.0KB')
    })

    it('should show KB for 1024*1024 - 1', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          files: [{ name: 'f.txt', isDirectory: false, size: 1024 * 1024 - 1 }],
        },
      })

      const result = await executor.execute('LS', { path: '~main/test' })
      expect(result).toContain('KB')
      expect(result).not.toContain('MB')
    })

    it('should show MB for exactly 1MB', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          files: [{ name: 'f.txt', isDirectory: false, size: 1024 * 1024 }],
        },
      })

      const result = await executor.execute('LS', { path: '~main/test' })
      expect(result).toContain('1.0MB')
    })

    it('should show 0B for zero-size file', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          files: [{ name: 'empty.txt', isDirectory: false, size: 0 }],
        },
      })

      const result = await executor.execute('LS', { path: '~main/test' })
      expect(result).toContain('0B')
    })
  })

  describe('Edit singular/plural', () => {
    it('should use singular "occurrence" for 1 replacement', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { replaced: 1 },
      })

      const result = await executor.execute(
        'Edit',
        { path: '~main/f.txt', old_text: 'a', new_text: 'b' },
        { toolPermissions: { allowAll: true } }
      )

      expect(result).toBe('Replaced 1 occurrence in /f.txt')
    })

    it('should use plural "occurrences" for multiple replacements', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { replaced: 3 },
      })

      const result = await executor.execute(
        'Edit',
        {
          path: '~main/f.txt',
          old_text: 'a',
          new_text: 'b',
          replace_all: true,
        },
        { toolPermissions: { allowAll: true } }
      )

      expect(result).toBe('Replaced 3 occurrences in /f.txt')
    })
  })

  describe('Glob/Grep empty results', () => {
    it('should return no matches for empty glob results', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { files: [] },
      })

      const result = await executor.execute('Glob', {
        pattern: '**/*.xyz',
        path: '~main/test',
      })
      expect(result).toBe('No matches found.')
    })

    it('should return no matches for empty grep results', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { results: [] },
      })

      const result = await executor.execute('Grep', {
        pattern: 'nonexistent',
        path: '~main/test',
      })
      expect(result).toBe('No matches found.')
    })

    it('should return no results for empty web search', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { results: [] },
      })

      const result = await executor.execute('WebSearch', { query: 'nothing' })
      expect(result).toBe('No results found.')
    })
  })

  describe('Git tool routing', () => {
    it('should route GitDiff with staged flag', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { output: 'diff output' },
      })

      const result = await executor.execute('GitDiff', {
        path: '~main/repo',
        staged: true,
        file: 'src/index.ts',
      })

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/git:diff',
        { path: '~main/repo', staged: true, file: 'src/index.ts' }
      )
      expect(result).toBe('diff output')
    })

    it('should route GitLog with maxCount', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { output: 'commit abc123' },
      })

      const result = await executor.execute('GitLog', {
        path: '~main/repo',
        maxCount: 5,
      })

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/git:log',
        { path: '~main/repo', maxCount: 5 }
      )
      expect(result).toBe('commit abc123')
    })

    it('should route GitCommit', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { output: '[main abc123] feat: add feature' },
      })

      const result = await executor.execute(
        'GitCommit',
        {
          path: '~main/repo',
          message: 'feat: add feature',
          files: ['src/index.ts'],
        },
        { toolPermissions: { allowAll: true } }
      )

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/git:commit',
        {
          path: '~main/repo',
          message: 'feat: add feature',
          files: ['src/index.ts'],
        }
      )
      expect(result).toContain('feat: add feature')
    })

    it('should route GitPush', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { output: 'pushed to origin/main' },
      })

      const result = await executor.execute(
        'GitPush',
        { path: '~main/repo', remote: 'origin', branch: 'main' },
        { toolPermissions: { allowAll: true } }
      )

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/git:push',
        { path: '~main/repo', remote: 'origin', branch: 'main' }
      )
      expect(result).toBe('pushed to origin/main')
    })

    it('should route GitCheckout with create flag', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { output: "Switched to branch 'feature'" },
      })

      const result = await executor.execute(
        'GitCheckout',
        { path: '~main/repo', branch: 'feature', create: true },
        { toolPermissions: { allowAll: true } }
      )

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/ipc/git:checkout',
        { path: '~main/repo', branch: 'feature', create: true }
      )
      expect(result).toContain('feature')
    })

    it('should combine output and error from git command', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { output: 'partial output', error: 'warning message' },
      })

      const result = await executor.execute('GitStatus', { path: '~main/repo' })
      expect(result).toBe('partial output\nwarning message')
    })

    it('should return only error when output is empty', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { output: '', error: 'fatal: not a git repo' },
      })

      const result = await executor.execute('GitStatus', { path: '~main/nope' })
      expect(result).toBe('fatal: not a git repo')
    })
  })

  describe('permission: sessionApprovedTools', () => {
    it('should allow tool via sessionApprovedTools', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { success: true },
      })

      const result = await executor.execute(
        'Write',
        { path: '~main/f.txt', content: 'hi' },
        { sessionApprovedTools: new Set(['Write']) }
      )

      expect(result).toContain('Successfully wrote')
      expect(axios.post).toHaveBeenCalled()
    })
  })

  describe('permission: deny via rules', () => {
    it('should deny tool when permission rule denies it', async () => {
      const result = await executor.execute(
        'Write',
        { path: '~main/secret.txt', content: 'x' },
        {
          permissionRules: [
            {
              id: 'deny-write',
              action: 'deny',
              tool: 'Write',
              source: 'project',
              description: 'No writes allowed',
            },
          ],
        }
      )

      expect(result).toContain('Error: Tool "Write" was denied')
      expect(result).toContain('No writes allowed')
      expect(axios.post).not.toHaveBeenCalled()
    })
  })
})
