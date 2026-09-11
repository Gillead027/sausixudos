import type { AccentColor, FriendRequestSummary, FriendSummary, RawFriendshipStatus } from '@sausixudos/shared';
import { isBlocked } from './blocks.js';
import { db } from './db.js';

interface FriendshipStatusRow {
  status: RawFriendshipStatus;
  requested_by: string;
}

interface FriendRow {
  id: string;
  username: string;
  accent_color: AccentColor;
  avatar_data_url: string;
  status_text: string;
  responded_at: number;
}

interface FriendRequestRow {
  id: string;
  username: string;
  accent_color: AccentColor;
  avatar_data_url: string;
  created_at: number;
}

// Ordem canônica (sempre a < b) — é o que a PRIMARY KEY de `friendships`
// exige, evita ter A-B e B-A como linhas separadas pro mesmo par.
function canonicalPair(idA: string, idB: string): [string, string] {
  return idA < idB ? [idA, idB] : [idB, idA];
}

const selectStatusStatement = db.prepare(
  'SELECT status, requested_by FROM friendships WHERE user_id_a = ? AND user_id_b = ?',
);
const insertPendingStatement = db.prepare(
  "INSERT INTO friendships (user_id_a, user_id_b, status, requested_by, created_at) VALUES (?, ?, 'PENDING', ?, ?)",
);
const acceptStatement = db.prepare(
  "UPDATE friendships SET status = 'ACCEPTED', responded_at = ? WHERE user_id_a = ? AND user_id_b = ?",
);
const deleteStatement = db.prepare('DELETE FROM friendships WHERE user_id_a = ? AND user_id_b = ?');

const listAcceptedStatement = db.prepare(`
  SELECT users.id, users.username, users.accent_color, users.avatar_data_url, users.status_text, friendships.responded_at
  FROM friendships
  INNER JOIN users ON users.id = CASE WHEN friendships.user_id_a = ? THEN friendships.user_id_b ELSE friendships.user_id_a END
  WHERE (friendships.user_id_a = ? OR friendships.user_id_b = ?) AND friendships.status = 'ACCEPTED'
  ORDER BY friendships.responded_at DESC
`);

const listIncomingStatement = db.prepare(`
  SELECT users.id, users.username, users.accent_color, users.avatar_data_url, friendships.created_at
  FROM friendships
  INNER JOIN users ON users.id = CASE WHEN friendships.user_id_a = ? THEN friendships.user_id_b ELSE friendships.user_id_a END
  WHERE (friendships.user_id_a = ? OR friendships.user_id_b = ?) AND friendships.status = 'PENDING' AND friendships.requested_by != ?
  ORDER BY friendships.created_at DESC
`);

const listOutgoingStatement = db.prepare(`
  SELECT users.id, users.username, users.accent_color, users.avatar_data_url, friendships.created_at
  FROM friendships
  INNER JOIN users ON users.id = CASE WHEN friendships.user_id_a = ? THEN friendships.user_id_b ELSE friendships.user_id_a END
  WHERE (friendships.user_id_a = ? OR friendships.user_id_b = ?) AND friendships.status = 'PENDING' AND friendships.requested_by = ?
  ORDER BY friendships.created_at DESC
`);

function toFriendSummary(row: FriendRow): FriendSummary {
  return {
    id: row.id,
    displayName: row.username,
    accentColor: row.accent_color,
    avatarUrl: row.avatar_data_url,
    statusText: row.status_text,
    since: row.responded_at,
  };
}

function toFriendRequestSummary(row: FriendRequestRow): FriendRequestSummary {
  return {
    userId: row.id,
    displayName: row.username,
    accentColor: row.accent_color,
    avatarUrl: row.avatar_data_url,
    createdAt: row.created_at,
  };
}

export function getFriendshipBetween(idA: string, idB: string): { status: RawFriendshipStatus; requestedBy: string | null } {
  const [a, b] = canonicalPair(idA, idB);
  const row = selectStatusStatement.get(a, b) as FriendshipStatusRow | undefined;
  return row ? { status: row.status, requestedBy: row.requested_by } : { status: 'NONE', requestedBy: null };
}

export function areFriends(idA: string, idB: string): boolean {
  return getFriendshipBetween(idA, idB).status === 'ACCEPTED';
}

export type SendFriendRequestResult =
  | { ok: true; status: 'PENDING' | 'ACCEPTED' }
  | { ok: false; reason: 'SELF' | 'BLOCKED' | 'ALREADY_REQUESTED' | 'ALREADY_FRIENDS' };

// Cobre pedir E aceitar automaticamente com a mesma chamada: se já existe um
// PENDING criado pelo ALVO (ou seja, o alvo já tinha pedido antes), esta
// chamada vira aceite em vez de duplicar/rejeitar — mesmo comportamento do
// Discord real quando os dois lados pedem amizade um ao outro quase ao
// mesmo tempo.
export function sendOrAcceptFriendRequest(requesterId: string, targetId: string): SendFriendRequestResult {
  if (requesterId === targetId) return { ok: false, reason: 'SELF' };
  if (isBlocked(requesterId, targetId)) return { ok: false, reason: 'BLOCKED' };

  const existing = getFriendshipBetween(requesterId, targetId);
  if (existing.status === 'ACCEPTED') return { ok: false, reason: 'ALREADY_FRIENDS' };
  if (existing.status === 'PENDING') {
    if (existing.requestedBy === requesterId) return { ok: false, reason: 'ALREADY_REQUESTED' };
    const [a, b] = canonicalPair(requesterId, targetId);
    acceptStatement.run(Date.now(), a, b);
    return { ok: true, status: 'ACCEPTED' };
  }

  const [a, b] = canonicalPair(requesterId, targetId);
  insertPendingStatement.run(a, b, requesterId, Date.now());
  return { ok: true, status: 'PENDING' };
}

export type RemoveFriendshipResult = { ok: true } | { ok: false; reason: 'NOT_FOUND' };

// Cobre recusar um pedido recebido, cancelar um pedido enviado, e desfazer
// uma amizade aceita — as três ações são a mesma operação (apagar a linha),
// não há necessidade de distinguir "recusar" de "cancelar" no banco.
export function removeFriendship(selfId: string, otherId: string): RemoveFriendshipResult {
  const [a, b] = canonicalPair(selfId, otherId);
  const result = deleteStatement.run(a, b);
  return result.changes > 0 ? { ok: true } : { ok: false, reason: 'NOT_FOUND' };
}

export function listFriends(userId: string): FriendSummary[] {
  return (listAcceptedStatement.all(userId, userId, userId) as unknown as FriendRow[]).map(toFriendSummary);
}

export function listIncomingRequests(userId: string): FriendRequestSummary[] {
  return (listIncomingStatement.all(userId, userId, userId, userId) as unknown as FriendRequestRow[]).map(toFriendRequestSummary);
}

export function listOutgoingRequests(userId: string): FriendRequestSummary[] {
  return (listOutgoingStatement.all(userId, userId, userId, userId) as unknown as FriendRequestRow[]).map(toFriendRequestSummary);
}
