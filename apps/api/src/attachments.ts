import { randomUUID } from 'node:crypto';
import { ATTACHMENT_FILENAME_MAX_LENGTH, type MessageAttachment } from '@sausixudos/shared';
import { db } from './db.js';

interface AttachmentRow {
  id: string;
  message_id: string | null;
  channel_id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: string;
  created_at: number;
}

export interface AttachmentRecord {
  id: string;
  messageId: string | null;
  channelId: string;
  objectKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: number;
}

const insertPendingStatement = db.prepare(`
  INSERT INTO message_attachments (id, message_id, channel_id, object_key, filename, content_type, size_bytes, uploaded_by, created_at)
  VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
`);
const selectByIdStatement = db.prepare('SELECT * FROM message_attachments WHERE id = ?');
const selectByMessageStatement = db.prepare(
  'SELECT * FROM message_attachments WHERE message_id = ? ORDER BY created_at ASC',
);
const selectByChannelForMessagesStatement = db.prepare(`
  SELECT * FROM message_attachments WHERE channel_id = ? AND message_id IS NOT NULL ORDER BY created_at ASC
`);
const attachToMessageStatement = db.prepare(
  'UPDATE message_attachments SET message_id = ? WHERE id = ? AND channel_id = ? AND uploaded_by = ? AND message_id IS NULL',
);
const deleteRowStatement = db.prepare('DELETE FROM message_attachments WHERE id = ?');
const selectOrphanedStatement = db.prepare(
  'SELECT * FROM message_attachments WHERE message_id IS NULL AND created_at < ?',
);

function toRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    channelId: row.channel_id,
    objectKey: row.object_key,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
  };
}

function toAttachment(record: AttachmentRecord): MessageAttachment {
  return {
    id: record.id,
    filename: record.filename,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    url: `/api/attachments/${record.id}/${encodeURIComponent(record.filename)}`,
  };
}

// Remove separadores de caminho e caracteres de controle do nome original —
// o arquivo nunca é salvo em disco/objeto com esse nome (o object_key no
// MinIO é sempre um UUID), mas o filename é ecoado de volta no
// Content-Disposition e na URL, então precisa ser seguro pra isso.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f]/g;

export function sanitizeFilename(original: string): string {
  const cleaned = original.replace(/[/\\]/g, '_').replace(CONTROL_CHARS_PATTERN, '').trim();
  return (cleaned || 'arquivo').slice(0, ATTACHMENT_FILENAME_MAX_LENGTH);
}

export function createPendingAttachment(params: {
  channelId: string;
  objectKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
}): AttachmentRecord {
  const id = randomUUID();
  const createdAt = Date.now();
  insertPendingStatement.run(
    id,
    params.channelId,
    params.objectKey,
    params.filename,
    params.contentType,
    params.sizeBytes,
    params.uploadedBy,
    createdAt,
  );
  return { id, messageId: null, ...params, createdAt };
}

export function getAttachmentRecordById(id: string): AttachmentRecord | undefined {
  const row = selectByIdStatement.get(id) as unknown as AttachmentRow | undefined;
  return row && toRecord(row);
}

export function getAttachmentsForMessage(messageId: string): MessageAttachment[] {
  return getAttachmentRecordsForMessage(messageId).map(toAttachment);
}

// Variante "completa" (com object_key) — usada só internamente pra saber o
// que apagar no MinIO quando a mensagem é apagada (ver index.ts). A versão
// pública (getAttachmentsForMessage) nunca expõe object_key ao cliente.
export function getAttachmentRecordsForMessage(messageId: string): AttachmentRecord[] {
  return (selectByMessageStatement.all(messageId) as unknown as AttachmentRow[]).map(toRecord);
}

// Usado por listTextMessages pra montar um mapa channel-inteiro de uma vez
// (evita N+1 — mesmo padrão de getReactionsByChannel em reactions.ts).
export function getAttachmentsByChannel(channelId: string): Map<string, MessageAttachment[]> {
  const rows = selectByChannelForMessagesStatement.all(channelId) as unknown as AttachmentRow[];
  const byMessage = new Map<string, MessageAttachment[]>();
  for (const row of rows) {
    if (!row.message_id) continue;
    const list = byMessage.get(row.message_id) ?? [];
    list.push(toAttachment(toRecord(row)));
    byMessage.set(row.message_id, list);
  }
  return byMessage;
}

// Só liga o upload pendente à mensagem se channel_id e uploaded_by baterem
// (ver comentário na tabela em db.ts) — devolve só os que realmente foram
// vinculados, pra createTextMessage saber exatamente o que embutir na
// resposta em vez de confiar cegamente na lista pedida pelo cliente.
export function attachToMessage(
  attachmentIds: string[],
  messageId: string,
  channelId: string,
  uploaderId: string,
): MessageAttachment[] {
  const linked: MessageAttachment[] = [];
  for (const attachmentId of attachmentIds) {
    const result = attachToMessageStatement.run(messageId, attachmentId, channelId, uploaderId);
    if (result.changes > 0) {
      const record = getAttachmentRecordById(attachmentId);
      if (record) linked.push(toAttachment(record));
    }
  }
  return linked;
}

export function deleteAttachmentRecord(id: string): void {
  deleteRowStatement.run(id);
}

// Uploads pendentes (nunca anexados a uma mensagem enviada) mais antigos que
// olderThanMs — varridos periodicamente (ver index.ts) pra não vazar
// storage com arquivos escolhidos mas nunca enviados.
export function listOrphanedAttachments(olderThanMs: number): AttachmentRecord[] {
  return (selectOrphanedStatement.all(Date.now() - olderThanMs) as unknown as AttachmentRow[]).map(toRecord);
}
