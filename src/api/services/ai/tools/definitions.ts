export const fileSystemTools = [
  {
    name: 'Bash',
    description:
      'Execute a shell command in the system. Use this to run build scripts, package managers, git commands, or other CLI tools. Commands run with a 30-second timeout.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description:
            'The shell command to execute (e.g., "npm install", "git status")',
        },
        cwd: {
          type: 'string',
          description:
            'Optional working directory for the command (defaults to workspace root)',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description:
      'Read the complete contents of a file from the file system. Use this when you need to examine, analyze, or work with the content of an existing file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'The absolute file path to read (e.g., /Users/username/project/src/index.ts)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'Write',
    description:
      'Create a new file or completely overwrite an existing file with new content. Use this when you need to create new files or replace the entire content of existing files. For making small changes to existing files, consider using Edit.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'The absolute file path to write to (e.g., /Users/username/project/src/newFile.ts)',
        },
        content: {
          type: 'string',
          description: 'The complete content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'Edit',
    description:
      'Update specific text in an existing file by replacing a target string with new content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'The absolute file path to edit (e.g., /Users/username/project/src/index.ts)',
        },
        old_text: {
          type: 'string',
          description: 'The exact text to replace',
        },
        new_text: {
          type: 'string',
          description: 'The replacement text',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences instead of the first match',
        },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'LS',
    description:
      'Get a detailed listing of all files and directories in a specified folder. Results include names, paths, types, sizes, and modification times. Use this to explore directory structure or find specific files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'The absolute path of the directory to list (e.g., /Users/username/project/src)',
        },
        pattern: {
          type: 'string',
          description:
            'Optional filter pattern to match against file names (e.g., ".ts" to show only TypeScript files)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'TodoWrite',
    description:
      'Write or replace the entire TODO list for the current session.',
    input_schema: {
      type: 'object' as const,
      properties: {
        todos: {
          type: 'array',
          description: 'The full list of TODO items to write',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Unique identifier for the todo item',
              },
              title: {
                type: 'string',
                description: 'Short description of the task',
              },
              status: {
                type: 'string',
                description: 'Current status of the task',
                enum: ['todo', 'in_progress', 'done'],
              },
              notes: {
                type: 'string',
                description: 'Optional additional details',
              },
            },
            required: ['id', 'title', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'Glob',
    description: 'Fast file pattern matching using glob patterns.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.tsx")',
        },
        path: {
          type: 'string',
          description: 'Base directory. Defaults to workspace root.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents using a regular expression.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        path: { type: 'string', description: 'Search directory' },
        glob: { type: 'string', description: 'File filter (e.g., "*.ts")' },
        ignoreCase: { type: 'boolean', description: 'Case insensitive' },
        maxResults: {
          type: 'number',
          description: 'Maximum number of matches',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'GitStatus',
    description: 'Get git repository status.',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'Repository path' } },
      required: [],
    },
  },
  {
    name: 'GitDiff',
    description: 'Show git diff.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Repository path' },
        staged: { type: 'boolean', description: 'Show staged diff only' },
        file: { type: 'string', description: 'File path filter' },
      },
      required: [],
    },
  },
  {
    name: 'GitLog',
    description: 'Show git commit history.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Repository path' },
        maxCount: { type: 'number', description: 'Max commits to return' },
      },
      required: [],
    },
  },
  {
    name: 'GitCommit',
    description: 'Create a git commit.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Repository path' },
        message: { type: 'string', description: 'Commit message' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to stage',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'GitPush',
    description: 'Push commits to remote.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Repository path' },
        remote: {
          type: 'string',
          description: 'Remote name (default: origin)',
        },
        branch: { type: 'string', description: 'Branch name' },
      },
      required: [],
    },
  },
  {
    name: 'GitCheckout',
    description: 'Switch branches.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Repository path' },
        branch: { type: 'string', description: 'Branch name' },
        create: {
          type: 'boolean',
          description: 'Create the branch if it does not exist',
        },
      },
      required: ['branch'],
    },
  },
  {
    name: 'WebFetch',
    description: 'Fetch content from a URL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to fetch (HTTPS only)' },
        maxLength: { type: 'number', description: 'Max content length' },
      },
      required: ['url'],
    },
  },
  {
    name: 'WebSearch',
    description: 'Search the web and return relevant results.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max number of results' },
        recencyDays: {
          type: 'number',
          description: 'Filter by recency (days)',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Domain allowlist',
        },
        engine: {
          type: 'string',
          description: 'Search engine (google or bing)',
          enum: ['google', 'bing'],
        },
      },
      required: ['query'],
    },
  },
]

// Lazy-loaded MCP manager to avoid SDK side effects at import time
let mcpManagerInstance: typeof import('../../mcp/manager').mcpManager | null =
  null

async function getMcpManager() {
  if (!mcpManagerInstance) {
    const { mcpManager } = await import('../../mcp/manager')
    mcpManagerInstance = mcpManager
  }
  return mcpManagerInstance
}

// Get all available tools (built-in + MCP)
// MCP tools are only included after initMcpTools() is called
export function getAllTools() {
  const mcpTools = mcpManagerInstance?.getToolDefinitions() ?? []
  return [...fileSystemTools, ...mcpTools]
}

// Initialize MCP tools (call this at app startup)
export async function initMcpTools() {
  await getMcpManager()
}
