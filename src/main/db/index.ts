import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'
import path from 'path'
import { app } from 'electron'

// Database instance
let db: ReturnType<typeof drizzle> | null = null

// Get database path (in user data directory)
// Use different database files for development and production
export function getDbPath(): string {
  const userDataPath = app.getPath('userData')
  const dbName = app.isPackaged ? 'crow-ai.db' : 'crow.db'
  return path.join(userDataPath, dbName)
}

// Initialize database
export function initDatabase() {
  if (db) return db

  const dbPath = getDbPath()
  console.log('📦 Initializing database at:', dbPath)

  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL') // Better performance
  sqlite.pragma('foreign_keys = ON') // Enable foreign keys

  db = drizzle(sqlite, { schema })

  // Run migrations
  try {
    const migrationsFolder = app.isPackaged
      ? path.join(process.resourcesPath, 'drizzle')
      : './drizzle'

    console.log('📦 Running migrations from:', migrationsFolder)
    migrate(db, { migrationsFolder })
    console.log('✅ Database migrations completed')
  } catch (error) {
    console.error('❌ Database migration failed:', error)
  }

  // Run manual schema migrations for new columns
  runSchemaMigrations(sqlite)

  return db
}

// Manual schema migrations for adding new columns
function runSchemaMigrations(sqlite: Database.Database) {
  try {
    // Check if thinking column exists in messages table
    const columns = sqlite.pragma('table_info(messages)') as { name: string }[]
    const hasThinking = columns.some(col => col.name === 'thinking')

    if (!hasThinking) {
      console.log('📦 Adding thinking column to messages table...')
      sqlite.exec('ALTER TABLE messages ADD COLUMN thinking TEXT')
      console.log('✅ Added thinking column')
    }

    // Create mcp_servers table if not exists
    const tables = sqlite.pragma('table_list') as { name: string }[]
    const hasMcpServers = tables.some(t => t.name === 'mcp_servers')

    if (!hasMcpServers) {
      console.log('📦 Creating mcp_servers table...')
      sqlite.exec(`
        CREATE TABLE mcp_servers (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL UNIQUE,
          command TEXT NOT NULL,
          args TEXT,
          env TEXT,
          enabled INTEGER DEFAULT 1 NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()) NOT NULL
        )
      `)
      console.log('✅ Created mcp_servers table')
    }

    // Create skills_directories table if not exists
    const hasSkillsDirectories = tables.some(
      t => t.name === 'skills_directories'
    )

    if (!hasSkillsDirectories) {
      console.log('📦 Creating skills_directories table...')
      sqlite.exec(`
        CREATE TABLE skills_directories (
          id TEXT PRIMARY KEY NOT NULL,
          path TEXT NOT NULL UNIQUE,
          enabled INTEGER DEFAULT 1 NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()) NOT NULL
        )
      `)
      console.log('✅ Created skills_directories table')
    }

    // Add workspace column to conversations table if not exists
    const convColumns = sqlite.pragma('table_info(conversations)') as {
      name: string
    }[]
    const hasWorkspace = convColumns.some(col => col.name === 'workspace')

    if (!hasWorkspace) {
      console.log('📦 Adding workspace column to conversations table...')
      sqlite.exec('ALTER TABLE conversations ADD COLUMN workspace TEXT')
      console.log('✅ Added workspace column')
    }

    // Add system_prompt column to conversations table if not exists
    const hasSystemPrompt = convColumns.some(
      col => col.name === 'system_prompt'
    )

    if (!hasSystemPrompt) {
      console.log('📦 Adding system_prompt column to conversations table...')
      sqlite.exec('ALTER TABLE conversations ADD COLUMN system_prompt TEXT')
      console.log('✅ Added system_prompt column')
    }

    // Add token stats columns to messages table if not exists
    const msgColumns = sqlite.pragma('table_info(messages)') as {
      name: string
    }[]
    const hasInputTokens = msgColumns.some(col => col.name === 'input_tokens')

    if (!hasInputTokens) {
      console.log('📦 Adding token stats columns to messages table...')
      sqlite.exec('ALTER TABLE messages ADD COLUMN input_tokens INTEGER')
      sqlite.exec('ALTER TABLE messages ADD COLUMN output_tokens INTEGER')
      sqlite.exec('ALTER TABLE messages ADD COLUMN duration_ms INTEGER')
      console.log('✅ Added token stats columns')
    }

    // Create prompt_presets table if not exists
    const hasPromptPresets = tables.some(t => t.name === 'prompt_presets')

    if (!hasPromptPresets) {
      console.log('📦 Creating prompt_presets table...')
      sqlite.exec(`
        CREATE TABLE prompt_presets (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
          updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
        )
      `)
      console.log('✅ Created prompt_presets table')
    }

    // Create memories table if not exists
    const hasMemories = tables.some(t => t.name === 'memories')

    if (!hasMemories) {
      console.log('📦 Creating memories table...')
      sqlite.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY NOT NULL,
          type TEXT NOT NULL,
          category TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT,
          source TEXT NOT NULL,
          conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          file_path TEXT,
          created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
          updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
        )
      `)
      console.log('✅ Created memories table')
    }

    // Add indexes to memories table (idempotent)
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`
    )
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_conversation_id ON memories(conversation_id)`
    )
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at)`
    )

    // Create FTS5 virtual table and triggers for memories
    const hasMemoriesFts = tables.some(t => t.name === 'memories_fts')

    if (!hasMemoriesFts) {
      console.log('📦 Creating memories FTS5 index and triggers...')
      sqlite.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content,
          tags,
          content=memories,
          content_rowid=rowid
        )
      `)

      sqlite.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, tags)
          VALUES (new.rowid, new.content, new.tags);
        END
      `)

      sqlite.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags)
          VALUES ('delete', old.rowid, old.content, old.tags);
        END
      `)

      sqlite.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags)
          VALUES ('delete', old.rowid, old.content, old.tags);
          INSERT INTO memories_fts(rowid, content, tags)
          VALUES (new.rowid, new.content, new.tags);
        END
      `)
      console.log('✅ Created memories FTS5 index and triggers')
    }

    // Add last_accessed_at column to memories table if not exists (P2-16: decay)
    const memColumns = sqlite.pragma('table_info(memories)') as {
      name: string
    }[]
    const hasLastAccessed = memColumns.some(
      col => col.name === 'last_accessed_at'
    )

    if (!hasLastAccessed) {
      console.log('📦 Adding last_accessed_at column to memories table...')
      sqlite.exec(
        'ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER DEFAULT (unixepoch())'
      )
      // Backfill existing rows with updated_at value
      sqlite.exec(
        'UPDATE memories SET last_accessed_at = updated_at WHERE last_accessed_at IS NULL'
      )
      console.log('✅ Added last_accessed_at column')
    }
    // 上下文压缩：messages 表新增 compressed、summary_of 列
    const msgColsForCompression = sqlite.pragma('table_info(messages)') as {
      name: string
    }[]
    const hasCompressed = msgColsForCompression.some(
      col => col.name === 'compressed'
    )

    if (!hasCompressed) {
      console.log('📦 Adding compression columns to messages table...')
      sqlite.exec(
        'ALTER TABLE messages ADD COLUMN compressed INTEGER DEFAULT 0'
      )
      sqlite.exec('ALTER TABLE messages ADD COLUMN summary_of TEXT')
      console.log('✅ Added compression columns')
    }

    // 对话级 token 统计列
    const hasTotalTokens = convColumns.some(
      col => col.name === 'total_input_tokens'
    )
    if (!hasTotalTokens) {
      console.log('📦 Adding token stats columns to conversations table...')
      sqlite.exec(
        'ALTER TABLE conversations ADD COLUMN total_input_tokens INTEGER DEFAULT 0'
      )
      sqlite.exec(
        'ALTER TABLE conversations ADD COLUMN total_output_tokens INTEGER DEFAULT 0'
      )
      console.log('✅ Added conversation token stats columns')
    }

    // Provider OAuth columns
    const providerColumns = sqlite.pragma('table_info(providers)') as {
      name: string
    }[]
    const hasAuthType = providerColumns.some(col => col.name === 'auth_type')
    if (!hasAuthType) {
      console.log('📦 Adding auth_type column to providers table...')
      sqlite.exec(
        "ALTER TABLE providers ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'api_key'"
      )
      console.log('✅ Added auth_type column')
    }

    const hasOauthProvider = providerColumns.some(
      col => col.name === 'oauth_provider'
    )
    if (!hasOauthProvider) {
      console.log('📦 Adding oauth_provider column to providers table...')
      sqlite.exec('ALTER TABLE providers ADD COLUMN oauth_provider TEXT')
      console.log('✅ Added oauth_provider column')
    }

    const hasOauthAutoFetchModels = providerColumns.some(
      col => col.name === 'oauth_auto_fetch_models'
    )
    if (!hasOauthAutoFetchModels) {
      console.log('📦 Adding oauth_auto_fetch_models column to providers table...')
      sqlite.exec(
        'ALTER TABLE providers ADD COLUMN oauth_auto_fetch_models INTEGER NOT NULL DEFAULT 0'
      )
      console.log('✅ Added oauth_auto_fetch_models column')
    }

    const hasModelSyncOnlyCreate = providerColumns.some(
      col => col.name === 'model_sync_only_create'
    )
    if (!hasModelSyncOnlyCreate) {
      console.log('📦 Adding model_sync_only_create column to providers table...')
      sqlite.exec(
        'ALTER TABLE providers ADD COLUMN model_sync_only_create INTEGER NOT NULL DEFAULT 0'
      )
      console.log('✅ Added model_sync_only_create column')
    }

    const hasModelSyncEnableNewModels = providerColumns.some(
      col => col.name === 'model_sync_enable_new_models'
    )
    if (!hasModelSyncEnableNewModels) {
      console.log(
        '📦 Adding model_sync_enable_new_models column to providers table...'
      )
      sqlite.exec(
        'ALTER TABLE providers ADD COLUMN model_sync_enable_new_models INTEGER NOT NULL DEFAULT 1'
      )
      console.log('✅ Added model_sync_enable_new_models column')
    }

    const hasModelSyncNameFilter = providerColumns.some(
      col => col.name === 'model_sync_name_filter'
    )
    if (!hasModelSyncNameFilter) {
      console.log('📦 Adding model_sync_name_filter column to providers table...')
      sqlite.exec('ALTER TABLE providers ADD COLUMN model_sync_name_filter TEXT')
      console.log('✅ Added model_sync_name_filter column')
    }

    const hasOauthAccessToken = providerColumns.some(
      col => col.name === 'oauth_access_token'
    )
    if (!hasOauthAccessToken) {
      console.log('📦 Adding oauth_access_token column to providers table...')
      sqlite.exec('ALTER TABLE providers ADD COLUMN oauth_access_token TEXT')
      console.log('✅ Added oauth_access_token column')
    }

    const hasOauthRefreshToken = providerColumns.some(
      col => col.name === 'oauth_refresh_token'
    )
    if (!hasOauthRefreshToken) {
      console.log('📦 Adding oauth_refresh_token column to providers table...')
      sqlite.exec('ALTER TABLE providers ADD COLUMN oauth_refresh_token TEXT')
      console.log('✅ Added oauth_refresh_token column')
    }

    const hasOauthExpiresAt = providerColumns.some(
      col => col.name === 'oauth_expires_at'
    )
    if (!hasOauthExpiresAt) {
      console.log('📦 Adding oauth_expires_at column to providers table...')
      sqlite.exec('ALTER TABLE providers ADD COLUMN oauth_expires_at INTEGER')
      console.log('✅ Added oauth_expires_at column')
    }

    const hasOauthAccountEmail = providerColumns.some(
      col => col.name === 'oauth_account_email'
    )
    if (!hasOauthAccountEmail) {
      console.log('📦 Adding oauth_account_email column to providers table...')
      sqlite.exec('ALTER TABLE providers ADD COLUMN oauth_account_email TEXT')
      console.log('✅ Added oauth_account_email column')
    }
  } catch (error) {
    console.error('❌ Schema migration failed:', error)
  }
}

// Get database instance
export function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}

// Close database connection
export function closeDatabase() {
  if (db) {
    // Better-sqlite3 doesn't have a close method on drizzle instance
    // The underlying Database will be closed when the process exits
    db = null
    console.log('📦 Database connection closed')
  }
}

// Export schema for use in services
export { schema }
