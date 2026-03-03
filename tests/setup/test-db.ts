import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '~main/db/schema'

/**
 * 创建测试数据库实例
 * 使用内存数据库，每个测试独立
 */
export function createTestDatabase() {
  const sqlite = new Database(':memory:')

  // Enable foreign keys
  sqlite.pragma('foreign_keys = ON')

  const db = drizzle(sqlite, { schema })

  // 创建表结构
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      api_key TEXT NOT NULL,
      base_url TEXT,
      api_format TEXT DEFAULT 'chat-completions',
      auth_type TEXT NOT NULL DEFAULT 'api_key',
      oauth_auto_fetch_models INTEGER NOT NULL DEFAULT 0,
      model_sync_only_create INTEGER NOT NULL DEFAULT 0,
      model_sync_enable_new_models INTEGER NOT NULL DEFAULT 1,
      model_sync_name_filter TEXT,
      oauth_provider TEXT,
      oauth_access_token TEXT,
      oauth_refresh_token TEXT,
      oauth_expires_at INTEGER,
      oauth_account_email TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      name TEXT NOT NULL,
      context_length INTEGER,
      is_custom INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      provider TEXT,
      model TEXT,
      workspace TEXT,
      system_prompt TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      thinking TEXT,
      timestamp INTEGER NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      duration_ms INTEGER,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      name TEXT NOT NULL,
      input TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tool_results (
      id TEXT PRIMARY KEY,
      tool_call_id TEXT NOT NULL,
      output TEXT NOT NULL,
      is_error INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      command TEXT NOT NULL,
      args TEXT,
      env TEXT,
      enabled INTEGER DEFAULT 1 NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_presets (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      data BLOB NOT NULL,
      note TEXT,
      size INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    -- FTS5 virtual table for full-text search
    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      content_type,
      content_id,
      conversation_id,
      searchable_text,
      content='',
      contentless_delete=1
    );
  `)

  // Create triggers for search index
  sqlite.exec(`
    -- Trigger: Insert conversation title into search index
    CREATE TRIGGER IF NOT EXISTS conversations_ai AFTER INSERT ON conversations BEGIN
      INSERT INTO search_index(content_type, content_id, conversation_id, searchable_text)
      VALUES ('conversation_title', NEW.id, NEW.id, NEW.title);
    END;

    -- Trigger: Update conversation title in search index
    CREATE TRIGGER IF NOT EXISTS conversations_au AFTER UPDATE OF title ON conversations BEGIN
      DELETE FROM search_index WHERE content_type = 'conversation_title' AND content_id = OLD.id;
      INSERT INTO search_index(content_type, content_id, conversation_id, searchable_text)
      VALUES ('conversation_title', NEW.id, NEW.id, NEW.title);
    END;

    -- Trigger: Delete conversation from search index
    CREATE TRIGGER IF NOT EXISTS conversations_ad AFTER DELETE ON conversations BEGIN
      DELETE FROM search_index WHERE conversation_id = OLD.id;
    END;

    -- Trigger: Insert message into search index
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO search_index(content_type, content_id, conversation_id, searchable_text)
      VALUES ('message', NEW.id, NEW.conversation_id, NEW.content);
    END;

    -- Trigger: Update message in search index
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
      DELETE FROM search_index WHERE content_type = 'message' AND content_id = OLD.id;
      INSERT INTO search_index(content_type, content_id, conversation_id, searchable_text)
      VALUES ('message', NEW.id, NEW.conversation_id, NEW.content);
    END;

    -- Trigger: Delete message from search index
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      DELETE FROM search_index WHERE content_type = 'message' AND content_id = OLD.id;
    END;

    -- Trigger: Insert tool call into search index
    CREATE TRIGGER IF NOT EXISTS tool_calls_ai AFTER INSERT ON tool_calls BEGIN
      INSERT INTO search_index(content_type, content_id, conversation_id, searchable_text)
      SELECT 'tool_call', NEW.id, m.conversation_id, NEW.name || ' ' || NEW.input
      FROM messages m WHERE m.id = NEW.message_id;
    END;

    -- Trigger: Delete tool call from search index
    CREATE TRIGGER IF NOT EXISTS tool_calls_ad AFTER DELETE ON tool_calls BEGIN
      DELETE FROM search_index WHERE content_type = 'tool_call' AND content_id = OLD.id;
    END;

    -- Trigger: Insert tool result into search index
    CREATE TRIGGER IF NOT EXISTS tool_results_ai AFTER INSERT ON tool_results BEGIN
      INSERT INTO search_index(content_type, content_id, conversation_id, searchable_text)
      SELECT 'tool_result', NEW.id, m.conversation_id, NEW.output
      FROM tool_calls tc
      JOIN messages m ON m.id = tc.message_id
      WHERE tc.id = NEW.tool_call_id;
    END;

    -- Trigger: Delete tool result from search index
    CREATE TRIGGER IF NOT EXISTS tool_results_ad AFTER DELETE ON tool_results BEGIN
      DELETE FROM search_index WHERE content_type = 'tool_result' AND content_id = OLD.id;
    END;

    -- Trigger: Insert attachment note into search index
    CREATE TRIGGER IF NOT EXISTS attachments_ai AFTER INSERT ON attachments
    WHEN NEW.note IS NOT NULL AND NEW.note != '' BEGIN
      INSERT INTO search_index(content_type, content_id, conversation_id, searchable_text)
      SELECT 'attachment_note', NEW.id, m.conversation_id, NEW.note
      FROM messages m WHERE m.id = NEW.message_id;
    END;

    -- Trigger: Update attachment note in search index
    CREATE TRIGGER IF NOT EXISTS attachments_au AFTER UPDATE OF note ON attachments
    WHEN NEW.note IS NOT NULL AND NEW.note != '' BEGIN
      DELETE FROM search_index WHERE content_type = 'attachment_note' AND content_id = OLD.id;
      INSERT INTO search_index(content_type, content_id, conversation_id, searchable_text)
      SELECT 'attachment_note', NEW.id, m.conversation_id, NEW.note
      FROM messages m WHERE m.id = NEW.message_id;
    END;

    -- Trigger: Delete attachment from search index
    CREATE TRIGGER IF NOT EXISTS attachments_ad AFTER DELETE ON attachments BEGIN
      DELETE FROM search_index WHERE content_type = 'attachment_note' AND content_id = OLD.id;
    END;
  `)

  return {
    db,
    sqlite,
    cleanup: () => sqlite.close()
  }
}

/**
 * 清空所有表数据
 */
export function clearDatabase(sqlite: Database.Database) {
  sqlite.exec(`
    DELETE FROM search_index;
    DELETE FROM attachments;
    DELETE FROM tool_results;
    DELETE FROM tool_calls;
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM models;
    DELETE FROM providers;
    DELETE FROM settings;
    DELETE FROM mcp_servers;
    DELETE FROM prompt_presets;
  `)
}
