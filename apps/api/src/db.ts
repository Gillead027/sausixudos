import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.DB_PATH), { recursive: true });

export const db = new DatabaseSync(config.DB_PATH);

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    accent_color TEXT NOT NULL,
    status_text TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS text_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS text_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES text_channels(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_text_messages_channel_created
    ON text_messages(channel_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS text_bot_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES text_channels(id) ON DELETE CASCADE,
    sender_name TEXT NOT NULL,
    text TEXT NOT NULL,
    music_card_json TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_text_bot_messages_channel_created
    ON text_bot_messages(channel_id, created_at DESC);
`);

db.prepare(
  `INSERT OR IGNORE INTO text_channels (id, name, description, created_by, created_at)
   VALUES ('geral', 'geral', 'Conversa geral da comunidade', NULL, ?)`,
).run(Date.now());

const existingColumns = new Set(
  (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((column) => column.name),
);
for (const [column, definition] of [
  ['bio', "TEXT NOT NULL DEFAULT ''"],
  ['pronouns', "TEXT NOT NULL DEFAULT ''"],
  ['avatar_data_url', "TEXT NOT NULL DEFAULT ''"],
  ['banner_data_url', "TEXT NOT NULL DEFAULT ''"],
] as const) {
  if (!existingColumns.has(column)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
  }
}
