import { randomUUID } from 'node:crypto';
import {
  MUSIC_BOT_DISPLAY_NAME,
  MUSIC_BOT_IDENTITY,
  type MusicNowPlayingCard,
  type TextChannel,
  type TextMessage,
} from '@sausixudos/shared';
import { db } from './db.js';
import { slugify } from './slug.js';
import type { UserRecord } from './users.js';

interface TextChannelRow {
  id: string;
  name: string;
  description: string;
  created_by: string | null;
  created_at: number;
}

interface TextMessageRow {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_name: string;
  text: string;
  created_at: number;
  edited_at: number | null;
}

interface TextBotMessageRow {
  id: string;
  channel_id: string;
  sender_name: string;
  text: string;
  music_card_json: string | null;
  created_at: number;
}

const listChannelsStatement = db.prepare(
  'SELECT * FROM text_channels ORDER BY created_at ASC, name COLLATE NOCASE ASC',
);
const selectChannelByIdStatement = db.prepare('SELECT * FROM text_channels WHERE id = ?');
const selectChannelByNameStatement = db.prepare(
  'SELECT * FROM text_channels WHERE name = ? COLLATE NOCASE',
);
const insertChannelStatement = db.prepare(
  'INSERT INTO text_channels (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
);
const insertMessageStatement = db.prepare(
  'INSERT INTO text_messages (id, channel_id, sender_id, text, created_at) VALUES (?, ?, ?, ?, ?)',
);
const listMessagesStatement = db.prepare(`
  SELECT
    messages.id,
    messages.channel_id,
    messages.sender_id,
    users.username AS sender_name,
    messages.text,
    messages.created_at,
    messages.edited_at
  FROM text_messages AS messages
  INNER JOIN users ON users.id = messages.sender_id
  WHERE messages.channel_id = ?
  ORDER BY messages.created_at DESC
  LIMIT ?
`);
const selectMessageByIdStatement = db.prepare(`
  SELECT
    messages.id,
    messages.channel_id,
    messages.sender_id,
    users.username AS sender_name,
    messages.text,
    messages.created_at,
    messages.edited_at
  FROM text_messages AS messages
  INNER JOIN users ON users.id = messages.sender_id
  WHERE messages.id = ? AND messages.channel_id = ?
`);
const updateMessageStatement = db.prepare(
  'UPDATE text_messages SET text = ?, edited_at = ? WHERE id = ? AND sender_id = ?',
);
const deleteMessageStatement = db.prepare('DELETE FROM text_messages WHERE id = ? AND sender_id = ?');

const listBotMessagesStatement = db.prepare(`
  SELECT id, channel_id, sender_name, text, music_card_json, created_at
  FROM text_bot_messages
  WHERE channel_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);
const upsertBotMessageStatement = db.prepare(`
  INSERT INTO text_bot_messages (id, channel_id, sender_name, text, music_card_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(channel_id) DO UPDATE SET
    id = excluded.id,
    sender_name = excluded.sender_name,
    text = excluded.text,
    music_card_json = excluded.music_card_json
`);
const deleteBotMessageByChannelStatement = db.prepare('DELETE FROM text_bot_messages WHERE channel_id = ?');
const listAllBotMessagesStatement = db.prepare(`
  SELECT id, channel_id, sender_name, text, music_card_json, created_at
  FROM text_bot_messages
`);
const deleteBotMessageByIdStatement = db.prepare('DELETE FROM text_bot_messages WHERE id = ?');

function toChannel(row: TextChannelRow): TextChannel {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function toMessage(row: TextMessageRow): TextMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderType: 'HUMAN',
    text: row.text,
    sentAt: row.created_at,
    ...(row.edited_at !== null ? { editedAt: row.edited_at } : {}),
  };
}

function toBotMessage(row: TextBotMessageRow): TextMessage {
  let musicCard: MusicNowPlayingCard | undefined;
  if (row.music_card_json) {
    try {
      musicCard = JSON.parse(row.music_card_json) as MusicNowPlayingCard;
    } catch {
      musicCard = undefined;
    }
  }
  return {
    id: row.id,
    channelId: row.channel_id,
    senderId: MUSIC_BOT_IDENTITY,
    senderName: row.sender_name,
    senderType: 'BOT',
    text: row.text,
    sentAt: row.created_at,
    ...(musicCard ? { musicCard } : {}),
  };
}

function channelSlug(name: string): string {
  return slugify(name, (id) => Boolean(selectChannelByIdStatement.get(id)));
}

export function listTextChannels(): TextChannel[] {
  return (listChannelsStatement.all() as unknown as TextChannelRow[]).map(toChannel);
}

export function getTextChannelById(id: string): TextChannel | undefined {
  const row = selectChannelByIdStatement.get(id) as unknown as TextChannelRow | undefined;
  return row && toChannel(row);
}

export function getTextChannelByName(name: string): TextChannel | undefined {
  const row = selectChannelByNameStatement.get(name) as unknown as TextChannelRow | undefined;
  return row && toChannel(row);
}

export function createTextChannel(
  name: string,
  description: string,
  creatorId: string,
): TextChannel {
  const channel: TextChannel = {
    id: channelSlug(name),
    name,
    description,
    createdBy: creatorId,
    createdAt: Date.now(),
  };
  insertChannelStatement.run(
    channel.id,
    channel.name,
    channel.description,
    channel.createdBy,
    channel.createdAt,
  );
  return channel;
}

export function listTextMessages(channelId: string, limit = 100): TextMessage[] {
  const humanMessages = (listMessagesStatement.all(channelId, limit) as unknown as TextMessageRow[])
    .map(toMessage);
  const botMessages = (listBotMessagesStatement.all(channelId, limit) as unknown as TextBotMessageRow[])
    .map(toBotMessage);
  return [...humanMessages, ...botMessages]
    .sort((left, right) => left.sentAt - right.sentAt)
    .slice(-limit);
}

export function createTextMessage(
  channelId: string,
  text: string,
  sender: UserRecord,
): TextMessage {
  const message: TextMessage = {
    id: randomUUID(),
    channelId,
    senderId: sender.id,
    senderName: sender.username,
    senderType: 'HUMAN',
    text,
    sentAt: Date.now(),
  };
  insertMessageStatement.run(
    message.id,
    message.channelId,
    message.senderId,
    message.text,
    message.sentAt,
  );
  return message;
}


export function getTextMessageById(channelId: string, messageId: string): TextMessage | undefined {
  const row = selectMessageByIdStatement.get(messageId, channelId) as unknown as TextMessageRow | undefined;
  return row && toMessage(row);
}

export type EditTextMessageResult =
  | { ok: true; message: TextMessage }
  | { ok: false; reason: 'NOT_FOUND' | 'FORBIDDEN' };

// Sem sistema de cargos ainda (ver DISCORD_PARITY_PLAN.md) — só o próprio
// autor pode editar/apagar, mesmo nível de moderação que o resto do app
// hoje (nenhum).
export function editTextMessage(
  channelId: string,
  messageId: string,
  text: string,
  editorId: string,
): EditTextMessageResult {
  const existing = getTextMessageById(channelId, messageId);
  if (!existing) return { ok: false, reason: 'NOT_FOUND' };
  if (existing.senderId !== editorId) return { ok: false, reason: 'FORBIDDEN' };
  const editedAt = Date.now();
  updateMessageStatement.run(text, editedAt, messageId, editorId);
  return { ok: true, message: { ...existing, text, editedAt } };
}

export type DeleteTextMessageResult = { ok: true } | { ok: false; reason: 'NOT_FOUND' | 'FORBIDDEN' };

export function deleteTextMessage(
  channelId: string,
  messageId: string,
  requesterId: string,
): DeleteTextMessageResult {
  const existing = getTextMessageById(channelId, messageId);
  if (!existing) return { ok: false, reason: 'NOT_FOUND' };
  if (existing.senderId !== requesterId) return { ok: false, reason: 'FORBIDDEN' };
  deleteMessageStatement.run(messageId, requesterId);
  return { ok: true };
}

export function getMusicBotTextMessage(channelId: string): TextMessage | undefined {
  const rows = listBotMessagesStatement.all(channelId, 1) as unknown as TextBotMessageRow[];
  const row = rows[0];
  return row ? toBotMessage(row) : undefined;
}

export function deleteMusicBotTextMessage(channelId: string): boolean {
  const result = deleteBotMessageByChannelStatement.run(channelId);
  return result.changes > 0;
}

// Retorna os ids dos canais de texto cujo card foi removido (normalmente no
// máximo um, já que upsertMusicBotTextMessage mantém só um card ativo por
// canal de voz — mas o caller precisa saber quais canais avisar via
// WebSocket, então devolvemos a lista real em vez de só uma contagem).
export function deleteMusicBotTextMessagesForVoiceChannel(
  voiceChannelId: string,
  exceptTextChannelId?: string,
): string[] {
  const rows = listAllBotMessagesStatement.all() as unknown as TextBotMessageRow[];
  const clearedChannelIds: string[] = [];
  for (const row of rows) {
    if (row.channel_id === exceptTextChannelId || !row.music_card_json) continue;
    try {
      const card = JSON.parse(row.music_card_json) as MusicNowPlayingCard;
      if (card.voiceChannelId !== voiceChannelId) continue;
      if (deleteBotMessageByIdStatement.run(row.id).changes) clearedChannelIds.push(row.channel_id);
    } catch {
      // Mensagem antiga/corrompida não deve impedir a limpeza das demais.
    }
  }
  return clearedChannelIds;
}

// Todo canal de texto que tem um card de "tocando agora" ativo agora —
// usado pelo laço de resync periódico em index.ts (ver ali) que mantém o
// progresso do card atualizado via WebSocket sem o cliente precisar pollar.
export function listActiveMusicBotChannelIds(): string[] {
  const rows = listAllBotMessagesStatement.all() as unknown as TextBotMessageRow[];
  return rows.filter((row) => row.music_card_json).map((row) => row.channel_id);
}

export function upsertMusicBotTextMessage(
  channelId: string,
  text: string,
  musicCard: MusicNowPlayingCard,
): { message: TextMessage; clearedChannelIds: string[] } {
  const clearedChannelIds = musicCard.voiceChannelId
    ? deleteMusicBotTextMessagesForVoiceChannel(musicCard.voiceChannelId, channelId)
    : [];
  const existing = getMusicBotTextMessage(channelId);
  const message: TextMessage = {
    id: `music-bot:${channelId}`,
    channelId,
    senderId: MUSIC_BOT_IDENTITY,
    senderName: MUSIC_BOT_DISPLAY_NAME,
    senderType: 'BOT',
    text,
    sentAt: existing?.sentAt ?? Date.now(),
    musicCard,
  };
  upsertBotMessageStatement.run(
    message.id,
    message.channelId,
    message.senderName,
    message.text,
    JSON.stringify(musicCard),
    message.sentAt,
  );
  return { message, clearedChannelIds };
}
