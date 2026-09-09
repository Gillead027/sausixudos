import type { VoiceChannel } from '@sausixudos/shared';
import { db } from './db.js';
import { slugify } from './slug.js';

interface VoiceChannelRow {
  id: string;
  name: string;
  description: string;
  position: number;
  created_by: string | null;
  created_at: number;
}

const listChannelsStatement = db.prepare('SELECT * FROM voice_channels ORDER BY position ASC, created_at ASC');
const selectChannelByIdStatement = db.prepare('SELECT * FROM voice_channels WHERE id = ?');
const selectChannelByNameStatement = db.prepare('SELECT * FROM voice_channels WHERE name = ? COLLATE NOCASE');
const selectMaxPositionStatement = db.prepare('SELECT MAX(position) AS maxPosition FROM voice_channels');
const insertChannelStatement = db.prepare(
  'INSERT INTO voice_channels (id, name, description, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
);
const deleteChannelStatement = db.prepare('DELETE FROM voice_channels WHERE id = ?');

function toChannel(row: VoiceChannelRow): VoiceChannel {
  return { id: row.id, name: row.name, description: row.description };
}

function channelSlug(name: string): string {
  return slugify(name, (id) => Boolean(selectChannelByIdStatement.get(id)));
}

export function listVoiceChannels(): VoiceChannel[] {
  return (listChannelsStatement.all() as unknown as VoiceChannelRow[]).map(toChannel);
}

export function getVoiceChannelById(id: string): VoiceChannel | undefined {
  const row = selectChannelByIdStatement.get(id) as unknown as VoiceChannelRow | undefined;
  return row && toChannel(row);
}

export function getVoiceChannelByName(name: string): VoiceChannel | undefined {
  const row = selectChannelByNameStatement.get(name) as unknown as VoiceChannelRow | undefined;
  return row && toChannel(row);
}

export function createVoiceChannel(name: string, description: string, creatorId: string): VoiceChannel {
  const { maxPosition } = selectMaxPositionStatement.get() as { maxPosition: number | null };
  const channel: VoiceChannel = { id: channelSlug(name), name, description };
  insertChannelStatement.run(channel.id, channel.name, channel.description, (maxPosition ?? -1) + 1, creatorId, Date.now());
  return channel;
}

export function deleteVoiceChannel(id: string): boolean {
  return deleteChannelStatement.run(id).changes > 0;
}
