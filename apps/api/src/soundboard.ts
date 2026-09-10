import { randomUUID } from 'node:crypto';
import type { SoundboardSound } from '@sausixudos/shared';
import { db } from './db.js';
import type { UserRecord } from './users.js';

interface SoundboardSoundRow {
  id: string;
  name: string;
  emoji: string;
  audio_data_url: string;
  duration_ms: number;
  created_by: string;
  created_by_name: string;
  created_at: number;
}

const listSoundsStatement = db.prepare(`
  SELECT
    sounds.id,
    sounds.name,
    sounds.emoji,
    sounds.audio_data_url,
    sounds.duration_ms,
    sounds.created_by,
    users.username AS created_by_name,
    sounds.created_at
  FROM soundboard_sounds AS sounds
  INNER JOIN users ON users.id = sounds.created_by
  ORDER BY sounds.created_at ASC
`);
const selectSoundByIdStatement = db.prepare('SELECT * FROM soundboard_sounds WHERE id = ?');
const insertSoundStatement = db.prepare(
  'INSERT INTO soundboard_sounds (id, name, emoji, audio_data_url, duration_ms, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
const deleteSoundStatement = db.prepare('DELETE FROM soundboard_sounds WHERE id = ? AND created_by = ?');
const deleteSoundAsModeratorStatement = db.prepare('DELETE FROM soundboard_sounds WHERE id = ?');

function toSound(row: SoundboardSoundRow): SoundboardSound {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    audioDataUrl: row.audio_data_url,
    durationMs: row.duration_ms,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
  };
}

export function listSoundboardSounds(): SoundboardSound[] {
  return (listSoundsStatement.all() as unknown as SoundboardSoundRow[]).map(toSound);
}

export function getSoundboardSoundById(id: string): { createdBy: string } | undefined {
  const row = selectSoundByIdStatement.get(id) as { created_by: string } | undefined;
  return row && { createdBy: row.created_by };
}

export function createSoundboardSound(
  name: string,
  emoji: string,
  audioDataUrl: string,
  durationMs: number,
  creator: UserRecord,
): SoundboardSound {
  const sound: SoundboardSound = {
    id: randomUUID(),
    name,
    emoji,
    audioDataUrl,
    durationMs,
    createdBy: creator.id,
    createdByName: creator.username,
    createdAt: Date.now(),
  };
  insertSoundStatement.run(sound.id, sound.name, sound.emoji, sound.audioDataUrl, sound.durationMs, sound.createdBy, sound.createdAt);
  return sound;
}

// canManageSoundboard vem da permissão MANAGE_SOUNDBOARD do cargo do
// requisitante (ver roles.ts) — permite apagar som enviado por outra pessoa,
// além do autor sempre poder apagar o próprio.
export function deleteSoundboardSound(id: string, requesterId: string, canManageSoundboard: boolean): boolean {
  if (canManageSoundboard) return deleteSoundAsModeratorStatement.run(id).changes > 0;
  return deleteSoundStatement.run(id, requesterId).changes > 0;
}
