import { REACTION_EMOJI, type MessageReactionGroup, type ReactionEmoji } from '@sausixudos/shared';
import { db } from './db.js';

interface ReactionRow {
  message_id: string;
  emoji: string;
  user_id: string;
}

const insertReactionStatement = db.prepare(
  'INSERT OR IGNORE INTO message_reactions (message_id, emoji, user_id, created_at) VALUES (?, ?, ?, ?)',
);
const deleteReactionStatement = db.prepare(
  'DELETE FROM message_reactions WHERE message_id = ? AND emoji = ? AND user_id = ?',
);
const listReactionsForMessageStatement = db.prepare(
  'SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id = ?',
);
// Uma única consulta pra todas as mensagens de um canal (em vez de N+1 por
// mensagem) — usada ao carregar o histórico inteiro do canal de uma vez.
const listReactionsForChannelStatement = db.prepare(`
  SELECT message_reactions.message_id, message_reactions.emoji, message_reactions.user_id
  FROM message_reactions
  INNER JOIN text_messages ON text_messages.id = message_reactions.message_id
  WHERE text_messages.channel_id = ?
`);

export function isValidReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === 'string' && (REACTION_EMOJI as readonly string[]).includes(value);
}

// Idempotente: reagir de novo com o mesmo emoji não duplica (chave primária
// composta), então não precisa checar existência antes.
export function addReaction(messageId: string, emoji: ReactionEmoji, userId: string): void {
  insertReactionStatement.run(messageId, emoji, userId, Date.now());
}

export function removeReaction(messageId: string, emoji: ReactionEmoji, userId: string): void {
  deleteReactionStatement.run(messageId, emoji, userId);
}

function groupByEmoji(rows: ReactionRow[]): MessageReactionGroup[] {
  const byEmoji = new Map<string, string[]>();
  for (const row of rows) {
    let userIds = byEmoji.get(row.emoji);
    if (!userIds) {
      userIds = [];
      byEmoji.set(row.emoji, userIds);
    }
    userIds.push(row.user_id);
  }
  return Array.from(byEmoji, ([emoji, userIds]) => ({ emoji: emoji as ReactionEmoji, userIds }));
}

export function getReactionsForMessage(messageId: string): MessageReactionGroup[] {
  return groupByEmoji(listReactionsForMessageStatement.all(messageId) as unknown as ReactionRow[]);
}

export function getReactionsByChannel(channelId: string): Map<string, MessageReactionGroup[]> {
  const rows = listReactionsForChannelStatement.all(channelId) as unknown as ReactionRow[];
  const byMessage = new Map<string, ReactionRow[]>();
  for (const row of rows) {
    const rowsForMessage = byMessage.get(row.message_id);
    if (rowsForMessage) rowsForMessage.push(row);
    else byMessage.set(row.message_id, [row]);
  }
  const result = new Map<string, MessageReactionGroup[]>();
  for (const [messageId, messageRows] of byMessage) {
    result.set(messageId, groupByEmoji(messageRows));
  }
  return result;
}
