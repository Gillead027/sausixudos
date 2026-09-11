import { randomUUID } from 'node:crypto';
import type { AccentColor, DmChannel, DmChannelParticipant, DmMessage } from '@sausixudos/shared';
import { areFriends } from './friendships.js';
import { db } from './db.js';
import type { UserRecord } from './users.js';

interface DmChannelRow {
  id: string;
  created_at: number;
  last_message_at: number | null;
  a_id: string;
  a_username: string;
  a_accent_color: AccentColor;
  a_avatar_data_url: string;
  b_id: string;
  b_username: string;
  b_accent_color: AccentColor;
  b_avatar_data_url: string;
}

interface DmMessageRow {
  id: string;
  dm_channel_id: string;
  sender_id: string;
  sender_name: string;
  text: string;
  created_at: number;
  edited_at: number | null;
}

function canonicalPair(idA: string, idB: string): [string, string] {
  return idA < idB ? [idA, idB] : [idB, idA];
}

const DM_CHANNEL_SELECT_COLUMNS = `
  dm_channels.id,
  dm_channels.created_at,
  dm_channels.last_message_at,
  a.id AS a_id, a.username AS a_username, a.accent_color AS a_accent_color, a.avatar_data_url AS a_avatar_data_url,
  b.id AS b_id, b.username AS b_username, b.accent_color AS b_accent_color, b.avatar_data_url AS b_avatar_data_url
`;

const selectChannelByPairStatement = db.prepare(`
  SELECT ${DM_CHANNEL_SELECT_COLUMNS}
  FROM dm_channels
  INNER JOIN users AS a ON a.id = dm_channels.user_id_a
  INNER JOIN users AS b ON b.id = dm_channels.user_id_b
  WHERE dm_channels.user_id_a = ? AND dm_channels.user_id_b = ?
`);
const selectChannelByIdStatement = db.prepare(`
  SELECT ${DM_CHANNEL_SELECT_COLUMNS}
  FROM dm_channels
  INNER JOIN users AS a ON a.id = dm_channels.user_id_a
  INNER JOIN users AS b ON b.id = dm_channels.user_id_b
  WHERE dm_channels.id = ?
`);
const listChannelsForUserStatement = db.prepare(`
  SELECT ${DM_CHANNEL_SELECT_COLUMNS}
  FROM dm_channels
  INNER JOIN users AS a ON a.id = dm_channels.user_id_a
  INNER JOIN users AS b ON b.id = dm_channels.user_id_b
  WHERE dm_channels.user_id_a = ? OR dm_channels.user_id_b = ?
  ORDER BY COALESCE(dm_channels.last_message_at, dm_channels.created_at) DESC
`);
const insertChannelStatement = db.prepare(
  'INSERT INTO dm_channels (id, user_id_a, user_id_b, created_at) VALUES (?, ?, ?, ?)',
);
const touchLastMessageStatement = db.prepare('UPDATE dm_channels SET last_message_at = ? WHERE id = ?');

const insertMessageStatement = db.prepare(
  'INSERT INTO dm_messages (id, dm_channel_id, sender_id, text, created_at) VALUES (?, ?, ?, ?, ?)',
);
const listMessagesStatement = db.prepare(`
  SELECT dm_messages.id, dm_messages.dm_channel_id, dm_messages.sender_id, users.username AS sender_name,
    dm_messages.text, dm_messages.created_at, dm_messages.edited_at
  FROM dm_messages
  INNER JOIN users ON users.id = dm_messages.sender_id
  WHERE dm_messages.dm_channel_id = ?
  ORDER BY dm_messages.created_at DESC
  LIMIT ?
`);
const selectMessageByIdStatement = db.prepare(`
  SELECT dm_messages.id, dm_messages.dm_channel_id, dm_messages.sender_id, users.username AS sender_name,
    dm_messages.text, dm_messages.created_at, dm_messages.edited_at
  FROM dm_messages
  INNER JOIN users ON users.id = dm_messages.sender_id
  WHERE dm_messages.id = ? AND dm_messages.dm_channel_id = ?
`);
const updateMessageStatement = db.prepare('UPDATE dm_messages SET text = ?, edited_at = ? WHERE id = ? AND sender_id = ?');
const deleteMessageStatement = db.prepare('DELETE FROM dm_messages WHERE id = ?');

function toParticipant(id: string, username: string, accentColor: AccentColor, avatarDataUrl: string): DmChannelParticipant {
  return { id, displayName: username, accentColor, avatarUrl: avatarDataUrl };
}

function toChannel(row: DmChannelRow): DmChannel {
  return {
    id: row.id,
    participants: [
      toParticipant(row.a_id, row.a_username, row.a_accent_color, row.a_avatar_data_url),
      toParticipant(row.b_id, row.b_username, row.b_accent_color, row.b_avatar_data_url),
    ],
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
  };
}

function toMessage(row: DmMessageRow): DmMessage {
  return {
    id: row.id,
    dmChannelId: row.dm_channel_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    text: row.text,
    sentAt: row.created_at,
    ...(row.edited_at !== null ? { editedAt: row.edited_at } : {}),
  };
}

export type OpenDmChannelResult = { ok: true; channel: DmChannel; created: boolean } | { ok: false; reason: 'NOT_FRIENDS' };

export function openDmChannel(selfId: string, targetId: string): OpenDmChannelResult {
  if (!areFriends(selfId, targetId)) return { ok: false, reason: 'NOT_FRIENDS' };
  const [a, b] = canonicalPair(selfId, targetId);
  const existing = selectChannelByPairStatement.get(a, b) as unknown as DmChannelRow | undefined;
  if (existing) return { ok: true, channel: toChannel(existing), created: false };

  const id = randomUUID();
  insertChannelStatement.run(id, a, b, Date.now());
  const row = selectChannelByIdStatement.get(id) as unknown as DmChannelRow;
  return { ok: true, channel: toChannel(row), created: true };
}

export function listDmChannelsForUser(userId: string): DmChannel[] {
  return (listChannelsForUserStatement.all(userId, userId) as unknown as DmChannelRow[]).map(toChannel);
}

// Única função de resolução usada por todas as rotas de mensagem —
// undefined tanto se o canal não existe quanto se userId não é participante,
// o que faz o 404 genérico em index.ts acontecer automaticamente (nunca
// 403, nunca revela a um terceiro que aquele dm_channel existe).
export function getDmChannelForParticipant(dmChannelId: string, userId: string): DmChannel | undefined {
  const row = selectChannelByIdStatement.get(dmChannelId) as unknown as DmChannelRow | undefined;
  if (!row) return undefined;
  const channel = toChannel(row);
  return channel.participants.some((participant) => participant.id === userId) ? channel : undefined;
}

export function listDmMessages(dmChannelId: string, limit = 100): DmMessage[] {
  return (listMessagesStatement.all(dmChannelId, limit) as unknown as DmMessageRow[]).map(toMessage);
}

export function getDmMessageById(dmChannelId: string, messageId: string): DmMessage | undefined {
  const row = selectMessageByIdStatement.get(messageId, dmChannelId) as unknown as DmMessageRow | undefined;
  return row && toMessage(row);
}

export function createDmMessage(dmChannelId: string, text: string, sender: UserRecord): DmMessage {
  const id = randomUUID();
  const createdAt = Date.now();
  insertMessageStatement.run(id, dmChannelId, sender.id, text, createdAt);
  touchLastMessageStatement.run(createdAt, dmChannelId);
  return {
    id,
    dmChannelId,
    senderId: sender.id,
    senderName: sender.username,
    text,
    sentAt: createdAt,
  };
}

export type EditDmMessageResult = { ok: true; message: DmMessage } | { ok: false; reason: 'NOT_FOUND' | 'FORBIDDEN' };

export function editDmMessage(dmChannelId: string, messageId: string, text: string, editorId: string): EditDmMessageResult {
  const existing = getDmMessageById(dmChannelId, messageId);
  if (!existing) return { ok: false, reason: 'NOT_FOUND' };
  if (existing.senderId !== editorId) return { ok: false, reason: 'FORBIDDEN' };
  const editedAt = Date.now();
  updateMessageStatement.run(text, editedAt, messageId, editorId);
  return { ok: true, message: { ...existing, text, editedAt } };
}

export type DeleteDmMessageResult = { ok: true } | { ok: false; reason: 'NOT_FOUND' | 'FORBIDDEN' };

export function deleteDmMessage(dmChannelId: string, messageId: string, requesterId: string): DeleteDmMessageResult {
  const existing = getDmMessageById(dmChannelId, messageId);
  if (!existing) return { ok: false, reason: 'NOT_FOUND' };
  if (existing.senderId !== requesterId) return { ok: false, reason: 'FORBIDDEN' };
  deleteMessageStatement.run(messageId);
  return { ok: true };
}
