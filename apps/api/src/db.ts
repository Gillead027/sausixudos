import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.DB_PATH), { recursive: true });

export const db = new DatabaseSync(config.DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    accent_color TEXT NOT NULL,
    status_text TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
`);

const existingColumns = new Set(
  (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((column) => column.name),
);
for (const [column, definition] of [
  ['bio', "TEXT NOT NULL DEFAULT ''"],
  ['pronouns', "TEXT NOT NULL DEFAULT ''"],
] as const) {
  if (!existingColumns.has(column)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
  }
}
