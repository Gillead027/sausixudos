import type { BanRecord } from '@sausixudos/shared';
import { db } from './db.js';

interface BanRow {
  user_id: string;
  username: string;
  reason: string;
  banned_by: string | null;
  banned_by_name: string | null;
  created_at: number;
}

const listBansStatement = db.prepare(`
  SELECT bans.user_id, users.username, bans.reason, bans.banned_by, moderators.username AS banned_by_name, bans.created_at
  FROM bans
  INNER JOIN users ON users.id = bans.user_id
  LEFT JOIN users AS moderators ON moderators.id = bans.banned_by
  ORDER BY bans.created_at DESC
`);
const selectBanStatement = db.prepare('SELECT user_id FROM bans WHERE user_id = ?');
const insertBanStatement = db.prepare(
  'INSERT OR REPLACE INTO bans (user_id, reason, banned_by, created_at) VALUES (?, ?, ?, ?)',
);
const deleteBanStatement = db.prepare('DELETE FROM bans WHERE user_id = ?');

function toBan(row: BanRow): BanRecord {
  return {
    userId: row.user_id,
    displayName: row.username,
    reason: row.reason,
    bannedBy: row.banned_by,
    bannedByName: row.banned_by_name,
    createdAt: row.created_at,
  };
}

export function isBanned(userId: string): boolean {
  return Boolean(selectBanStatement.get(userId));
}

export function listBans(): BanRecord[] {
  return (listBansStatement.all() as unknown as BanRow[]).map(toBan);
}

export function banUser(userId: string, reason: string, bannedBy: string): void {
  insertBanStatement.run(userId, reason, bannedBy, Date.now());
}

export function unbanUser(userId: string): boolean {
  return deleteBanStatement.run(userId).changes > 0;
}

export type ModerationAuthorization =
  | { ok: true }
  | { ok: false; reason: 'SELF' | 'INSUFFICIENT_RANK' };

// Regra de hierarquia única para kick/ban/timeout: só pode agir sobre quem
// tem a posição de cargo mais alta estritamente MENOR que a sua. Isso
// impede um moderador de agir contra um admin (ou outro moderador de
// mesma posição) e é deliberadamente mais simples que a hierarquia
// completa do Discord (sem "dono do servidor" à parte) — suficiente pra um
// grupo fechado de amigos (ver DISCORD_PARITY_PLAN.md).
//
// Função pura (posições já resolvidas pelo chamador via roles.ts) de
// propósito — mesmo padrão de authorizeVoiceDisconnect em voiceModeration.ts,
// pra dar pra testar a regra de hierarquia sem tocar no banco.
export function authorizeModerationAction(
  requesterId: string,
  requesterPosition: number,
  targetId: string,
  targetPosition: number,
): ModerationAuthorization {
  if (requesterId === targetId) return { ok: false, reason: 'SELF' };
  if (requesterPosition <= targetPosition) return { ok: false, reason: 'INSUFFICIENT_RANK' };
  return { ok: true };
}
