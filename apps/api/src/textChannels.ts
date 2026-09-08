import { randomUUID } from 'node:crypto';
import {
  MUSIC_BOT_DISPLAY_NAME,
  MUSIC_BOT_IDENTITY,
  type MusicNowPlayingCard,
  type TextChannel,
  type TextMessage,
} from '@sausixudos/shared';
import { db } from './db.js';
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
    messages.created_at
  FROM text_messages AS messages
  INNER JOIN users ON users.id = messages.sender_id
  WHERE messages.channel_id = ?
  ORDER BY messages.created_at DESC
  LIMIT ?
`);

const listBotMessagesStatement = db.prepare(`
  SELECT id, channel_id, sender_name, text, music_card_json, created_at
  FROM text_bot_messages
  WHERE channel_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);
const insertBotMessageStatement = db.prepare(`
  INSERT INTO text_bot_messages (id, channel_id, sender_name, text, music_card_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

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
  const base = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'canal';
  return selectChannelByIdStatement.get(base)
    ? `${base}-${randomUUID().slice(0, 6)}`
    : base;
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


export function createMusicBotTextMessage(
  channelId: string,
  text: string,
  musicCard: MusicNowPlayingCard,
): TextMessage {
  const message: TextMessage = {
    id: randomUUID(),
    channelId,
    senderId: MUSIC_BOT_IDENTITY,
    senderName: MUSIC_BOT_DISPLAY_NAME,
    senderType: 'BOT',
    text,
    sentAt: Date.now(),
    musicCard,
  };
  insertBotMessageStatement.run(
    message.id,
    message.channelId,
    message.senderName,
    message.text,
    JSON.stringify(musicCard),
    message.sentAt,
  );
  return message;
}
