import type { AccentColor, BlockedUserSummary } from '@sausixudos/shared';
import { db } from './db.js';
import { removeFriendship } from './friendships.js';

interface BlockedUserRow {
  id: string;
  username: string;
  accent_color: AccentColor;
  avatar_data_url: string;
  created_at: number;
}

const selectBlockStatement = db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?');
const insertBlockStatement = db.prepare(
  'INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)',
);
const deleteBlockStatement = db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?');
const listBlockedStatement = db.prepare(`
  SELECT users.id, users.username, users.accent_color, users.avatar_data_url, blocks.created_at
  FROM blocks
  INNER JOIN users ON users.id = blocks.blocked_id
  WHERE blocks.blocker_id = ?
  ORDER BY blocks.created_at DESC
`);

export function hasBlockedUser(blockerId: string, blockedId: string): boolean {
  return Boolean(selectBlockStatement.get(blockerId, blockedId));
}

// Direcional — bloqueio não é simétrico, então checa os dois sentidos
// (usado pra gate de pedido de amizade/envio de DM, onde não importa quem
// bloqueou quem, só que exista bloqueio entre os dois).
export function isBlocked(idA: string, idB: string): boolean {
  return hasBlockedUser(idA, idB) || hasBlockedUser(idB, idA);
}

export type BlockUserResult = { ok: true; friendshipRemoved: boolean } | { ok: false; reason: 'SELF' };

export function blockUser(blockerId: string, blockedId: string): BlockUserResult {
  if (blockerId === blockedId) return { ok: false, reason: 'SELF' };
  insertBlockStatement.run(blockerId, blockedId, Date.now());
  const friendshipRemoved = removeFriendship(blockerId, blockedId).ok;
  return { ok: true, friendshipRemoved };
}

export function unblockUser(blockerId: string, blockedId: string): boolean {
  return deleteBlockStatement.run(blockerId, blockedId).changes > 0;
}

export function listBlockedUsers(blockerId: string): BlockedUserSummary[] {
  return (listBlockedStatement.all(blockerId) as unknown as BlockedUserRow[]).map((row) => ({
    userId: row.id,
    displayName: row.username,
    accentColor: row.accent_color,
    avatarUrl: row.avatar_data_url,
    createdAt: row.created_at,
  }));
}
