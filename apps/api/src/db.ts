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

  CREATE TABLE IF NOT EXISTS voice_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
`);

// O SausiMusic mantém um único player persistente por canal de texto. Limpa
// duplicatas deixadas pela versão anterior antes de aplicar a unicidade.
db.exec(`
  DELETE FROM text_bot_messages
  WHERE rowid NOT IN (
    SELECT MAX(rowid) FROM text_bot_messages GROUP BY channel_id
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_text_bot_messages_channel_unique
    ON text_bot_messages(channel_id);
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

// Canais de voz eram só o env var VOICE_CHANNELS, parseado no boot (ver
// config.ts) — agora viram linhas reais, mas sem perder o que já estava
// configurado em produção: só semeia se a tabela ainda estiver vazia (ou
// seja, primeira vez que este código roda contra um banco existente).
const voiceChannelCount = (
  db.prepare('SELECT COUNT(*) AS count FROM voice_channels').get() as { count: number }
).count;
if (voiceChannelCount === 0) {
  const insertVoiceChannel = db.prepare(
    'INSERT INTO voice_channels (id, name, description, position, created_by, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
  );
  const seededAt = Date.now();
  config.channels.forEach((channel, index) => {
    insertVoiceChannel.run(channel.id, channel.name, channel.description, index, seededAt);
  });
}
