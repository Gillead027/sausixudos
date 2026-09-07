import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { AccentColor } from '@sausixudos/shared';
import { db } from './db.js';

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  accentColor: AccentColor;
  statusText: string;
  bio: string;
  pronouns: string;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  accent_color: AccentColor;
  status_text: string;
  bio: string;
  pronouns: string;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    accentColor: row.accent_color,
    statusText: row.status_text,
    bio: row.bio,
    pronouns: row.pronouns,
  };
}

const insertUser = db.prepare(
  'INSERT INTO users (id, username, password_hash, accent_color, status_text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
);
const selectByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const selectById = db.prepare('SELECT * FROM users WHERE id = ?');
const updateProfileStatement = db.prepare(
  'UPDATE users SET accent_color = ?, status_text = ?, bio = ?, pronouns = ? WHERE id = ?',
);

export function createUser(username: string, password: string, accentColor: AccentColor): UserRecord {
  const id = randomUUID();
  const passwordHash = bcrypt.hashSync(password, 10);
  insertUser.run(id, username, passwordHash, accentColor, '', Date.now());
  return { id, username, passwordHash, accentColor, statusText: '', bio: '', pronouns: '' };
}

export function getUserByUsername(username: string): UserRecord | undefined {
  const row = selectByUsername.get(username) as UserRow | undefined;
  return row && toRecord(row);
}

export function getUserById(id: string): UserRecord | undefined {
  const row = selectById.get(id) as UserRow | undefined;
  return row && toRecord(row);
}

export function verifyPassword(user: UserRecord, password: string): boolean {
  return bcrypt.compareSync(password, user.passwordHash);
}

export function updateUserProfile(
  id: string,
  accentColor: AccentColor,
  statusText: string,
  bio: string,
  pronouns: string,
): void {
  updateProfileStatement.run(accentColor, statusText, bio, pronouns, id);
}
