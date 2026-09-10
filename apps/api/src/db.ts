import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_EVERYONE_PERMISSIONS, EVERYONE_ROLE_ID, Permission } from '@sausixudos/shared';
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

  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT NOT NULL REFERENCES text_messages(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, emoji, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_message_reactions_message
    ON message_reactions(message_id);

  CREATE TABLE IF NOT EXISTS soundboard_sounds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    audio_data_url TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    color TEXT NOT NULL,
    position INTEGER NOT NULL,
    hoist INTEGER NOT NULL DEFAULT 0,
    permissions INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_roles (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS bans (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '',
    banned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
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

function ensureColumns(table: string, columns: readonly (readonly [string, string])[]): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name),
  );
  for (const [column, definition] of columns) {
    if (!existing.has(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

ensureColumns('users', [
  ['bio', "TEXT NOT NULL DEFAULT ''"],
  ['pronouns', "TEXT NOT NULL DEFAULT ''"],
  ['avatar_data_url', "TEXT NOT NULL DEFAULT ''"],
  ['banner_data_url', "TEXT NOT NULL DEFAULT ''"],
  ['timeout_until', 'INTEGER'],
]);

ensureColumns('text_messages', [
  ['edited_at', 'INTEGER'],
  // Sem FK aqui de propósito: SQLite valida FKs só na hora de escrever,
  // então referenciar uma mensagem que pode ter sido apagada é seguro —
  // basta o app tratar "não encontrada" ao resolver o preview da resposta.
  ['reply_to_message_id', 'TEXT'],
]);

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

// Cargos não existiam antes — semeia só na primeira vez que este código roda
// contra um banco existente (tabela `roles` vazia), preservando qualquer
// atribuição futura feita pela própria aplicação. O cargo "@everyone" recebe
// exatamente as permissões que todo mundo já tinha antes de cargos existirem
// (ver DEFAULT_EVERYONE_PERMISSIONS em packages/shared), então nenhum
// usuário perde capacidade nenhuma com esta migração. A conta mais antiga
// (menor created_at) vira Administrador automaticamente — sem isso o sistema
// de permissões nasceria sem ninguém capaz de gerenciar cargos/moderação.
const roleCount = (db.prepare('SELECT COUNT(*) AS count FROM roles').get() as { count: number }).count;
if (roleCount === 0) {
  const seededAt = Date.now();
  db.prepare(
    'INSERT INTO roles (id, name, color, position, hoist, permissions, created_at) VALUES (?, ?, ?, 0, 0, ?, ?)',
  ).run(EVERYONE_ROLE_ID, '@everyone', '#8a91a6', DEFAULT_EVERYONE_PERMISSIONS, seededAt);

  const insertUserRole = db.prepare(
    'INSERT OR IGNORE INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)',
  );
  const allUsers = db.prepare('SELECT id, created_at FROM users').all() as { id: string; created_at: number }[];
  for (const user of allUsers) {
    insertUserRole.run(user.id, EVERYONE_ROLE_ID, seededAt);
  }

  if (allUsers.length > 0) {
    const owner = allUsers.reduce((oldest, user) => (user.created_at < oldest.created_at ? user : oldest));
    const adminRoleId = randomUUID();
    db.prepare(
      'INSERT INTO roles (id, name, color, position, hoist, permissions, created_at) VALUES (?, ?, ?, 100, 1, ?, ?)',
    ).run(adminRoleId, 'Administrador', '#ee7798', Permission.ADMINISTRATOR, seededAt);
    insertUserRole.run(owner.id, adminRoleId, seededAt);
  }
}
