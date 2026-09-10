import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from 'livekit-server-sdk';
import multer, { MulterError } from 'multer';
import { z } from 'zod';
import {
  ACCENT_COLORS,
  MUSIC_BOT_IDENTITY,
  ATTACHMENT_INLINE_IMAGE_TYPES,
  ATTACHMENT_MAX_PER_MESSAGE,
  ATTACHMENT_MAX_SIZE_BYTES,
  AVATAR_DATA_URL_MAX_LENGTH,
  BAN_REASON_MAX_LENGTH,
  BANNER_DATA_URL_MAX_LENGTH,
  BIO_MAX_LENGTH,
  CHAT_MESSAGE_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  EVERYONE_ROLE_ID,
  hasPermission,
  MESSAGE_SEARCH_QUERY_MAX_LENGTH,
  MESSAGE_SEARCH_QUERY_MIN_LENGTH,
  MESSAGE_SEARCH_RESULTS_LIMIT,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  Permission,
  PRONOUNS_MAX_LENGTH,
  ROLE_NAME_MAX_LENGTH,
  SOUNDBOARD_AUDIO_DATA_URL_MAX_LENGTH,
  SOUNDBOARD_MAX_DURATION_MS,
  SOUNDBOARD_NAME_MAX_LENGTH,
  STATUS_TEXT_MAX_LENGTH,
  TEXT_CHANNEL_DESCRIPTION_MAX_LENGTH,
  TEXT_CHANNEL_NAME_MAX_LENGTH,
  TIMEOUT_MAX_MINUTES,
  type LiveKitTokenResponse,
  parseParticipantMetadata,
  type HumanParticipantMetadata,
  type MusicCommandResponse,
  type MusicNowPlayingCard,
  type PublicConfig,
  type RoomSummary,
  type UserSession,
  type VoiceChannel,
} from '@sausixudos/shared';
import { config } from './config.js';
import {
  clearSessionCookie,
  createSession,
  getSession,
  inviteMatches,
  setSessionCookie,
} from './session.js';
import {
  createUser,
  getUserById,
  getUserByUsername,
  setUserTimeout,
  updateUserProfile,
  verifyPassword,
  type UserRecord,
} from './users.js';
import {
  deleteMusicBotTextMessage,
  deleteMusicBotTextMessagesForVoiceChannel,
  deleteTextMessage,
  editTextMessage,
  getTextMessageById,
  upsertMusicBotTextMessage,
  createTextChannel,
  createTextMessage,
  getMusicBotTextMessage,
  getTextChannelById,
  getTextChannelByName,
  listActiveMusicBotChannelIds,
  listPinnedMessages,
  listTextChannels,
  listTextMessages,
  pinTextMessage,
  searchTextMessages,
  unpinTextMessage,
} from './textChannels.js';
import { addReaction, isValidReactionEmoji, removeReaction } from './reactions.js';
import { authorizeMusicCommand } from './musicCommands.js';
import { fetchMusicThumbnail } from './musicThumbnails.js';
import { authorizeVoiceDisconnect } from './voiceModeration.js';
import { attachRealtime, broadcast, disconnectUser } from './realtime.js';
import {
  createVoiceChannel,
  deleteVoiceChannel,
  getVoiceChannelById,
  getVoiceChannelByName,
  listVoiceChannels,
} from './voiceChannels.js';
import { createSoundboardSound, deleteSoundboardSound, getSoundboardSoundById, listSoundboardSounds } from './soundboard.js';
import {
  createPendingAttachment,
  deleteAttachmentRecord,
  getAttachmentRecordById,
  getAttachmentRecordsForMessage,
  listOrphanedAttachments,
  sanitizeFilename,
} from './attachments.js';
import { deleteAttachmentObject, ensureAttachmentsBucket, getAttachmentObjectStream, uploadAttachmentObject } from './storage.js';
import {
  assignDefaultRole,
  assignRole,
  createRole,
  deleteRole,
  getRoleById,
  getRoleByName,
  getUserHighestPosition,
  getUserPermissionBitfield,
  getUserRoleIds,
  listMembers,
  listRoles,
  unassignRole,
  updateRole,
} from './roles.js';
import { authorizeModerationAction, banUser, isBanned, listBans, unbanUser } from './moderation.js';

const app = express();
const roomService = new RoomServiceClient(
  config.LIVEKIT_INTERNAL_URL,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);

if (config.isProduction) app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  cors({
    origin: config.WEB_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  }),
);
app.use(express.json({ limit: '2mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' },
});

const textMessageLimiter = rateLimit({
  windowMs: 10 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Você está enviando mensagens rápido demais.' },
});

const reactionLimiter = rateLimit({
  windowMs: 10 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Muitas reações em pouco tempo.' },
});

const channelCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Limite de criação de canais atingido. Tente novamente mais tarde.' },
});

const roleLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Limite de alterações de cargo atingido. Tente novamente mais tarde.' },
});

const moderationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Muitas ações de moderação em pouco tempo.' },
});

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Muitos envios de arquivo em pouco tempo.' },
});

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ATTACHMENT_MAX_SIZE_BYTES, files: 1 },
});

// Envolve o middleware do multer manualmente pra devolver um erro amigável
// (413 com o teto real) em vez de cair no handler de erro genérico do fim
// do arquivo — multer chama next(error) em vez de lançar, e um MulterError
// por tamanho de arquivo merece uma resposta diferente de um 500 qualquer.
function handleAttachmentUpload(request: Request, response: Response, next: NextFunction): void {
  attachmentUpload.single('file')(request, response, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof MulterError && error.code === 'LIMIT_FILE_SIZE') {
      response.status(413).json({ error: `Arquivo muito grande — máximo de ${Math.floor(ATTACHMENT_MAX_SIZE_BYTES / 1024 / 1024)}MB.` });
      return;
    }
    response.status(400).json({ error: 'Não foi possível processar o arquivo enviado.' });
  });
}

const usernameSchema = z
  .string()
  .trim()
  .min(DISPLAY_NAME_MIN_LENGTH)
  .max(DISPLAY_NAME_MAX_LENGTH)
  .regex(/^[\p{L}\p{N} _.-]+$/u, 'O nome contém caracteres não permitidos.');

const registerSchema = z.object({
  username: usernameSchema,
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  inviteToken: z.string().min(1),
  accentColor: z.enum(ACCENT_COLORS),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const dataUrlPattern = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const audioDataUrlPattern = /^data:audio\/(mpeg|ogg|wav|webm);base64,[A-Za-z0-9+/]+=*$/;

const soundboardSoundSchema = z.object({
  name: z.string().trim().min(1).max(SOUNDBOARD_NAME_MAX_LENGTH),
  emoji: z.string().trim().min(1).max(8),
  audioDataUrl: z.string().max(SOUNDBOARD_AUDIO_DATA_URL_MAX_LENGTH).refine((value) => audioDataUrlPattern.test(value), 'Áudio inválido.'),
  durationMs: z.number().int().positive().max(SOUNDBOARD_MAX_DURATION_MS),
});

const profileSchema = z.object({
  accentColor: z.enum(ACCENT_COLORS),
  statusText: z.string().trim().max(STATUS_TEXT_MAX_LENGTH).default(''),
  bio: z.string().trim().max(BIO_MAX_LENGTH).default(''),
  pronouns: z.string().trim().max(PRONOUNS_MAX_LENGTH).default(''),
  avatarUrl: z
    .string()
    .max(AVATAR_DATA_URL_MAX_LENGTH)
    .refine((value) => value === '' || dataUrlPattern.test(value), 'Avatar inválido.')
    .default(''),
  bannerUrl: z
    .string()
    .max(BANNER_DATA_URL_MAX_LENGTH)
    .refine((value) => value === '' || dataUrlPattern.test(value), 'Banner inválido.')
    .default(''),
});

const tokenSchema = z.object({ roomId: z.string().min(1).max(32) });
const disconnectParticipantSchema = z.object({
  roomId: z.string().min(1).max(32),
  identity: z.string().min(1).max(128),
});

const musicCommandSchema = z.object({
  roomId: z.string().min(1).max(32),
  text: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_LENGTH),
  textChannelId: z.string().min(1).max(32).optional(),
});

const channelSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(TEXT_CHANNEL_NAME_MAX_LENGTH)
    .regex(/^[\p{L}\p{N} _-]+$/u),
  description: z.string().trim().max(TEXT_CHANNEL_DESCRIPTION_MAX_LENGTH).default(''),
});

const textMessageSchema = z.object({
  // Sem mínimo aqui de propósito: uma mensagem só de anexo (imagem sem
  // legenda, igual Discord real) é válida — a checagem "tem que ter texto OU
  // anexo" é feita na própria rota, depois de validar isto.
  text: z.string().trim().max(CHAT_MESSAGE_MAX_LENGTH),
  replyToMessageId: z.string().min(1).max(64).optional(),
  attachmentIds: z.array(z.string().min(1)).max(ATTACHMENT_MAX_PER_MESSAGE).optional(),
});

const reactionSchema = z.object({
  emoji: z.string().refine(isValidReactionEmoji, 'Emoji não suportado.'),
});

const ALL_PERMISSIONS_MASK = Object.values(Permission).reduce((mask, flag) => mask | flag, 0);
const permissionsBitfieldSchema = z.number().int().min(0).max(ALL_PERMISSIONS_MASK);
const roleColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor inválida.');

const roleCreateSchema = z.object({
  name: z.string().trim().min(1).max(ROLE_NAME_MAX_LENGTH),
  color: roleColorSchema,
  permissions: permissionsBitfieldSchema,
  hoist: z.boolean().default(false),
});

const roleUpdateSchema = z.object({
  name: z.string().trim().min(1).max(ROLE_NAME_MAX_LENGTH).optional(),
  color: roleColorSchema.optional(),
  permissions: permissionsBitfieldSchema.optional(),
  hoist: z.boolean().optional(),
});

const timeoutSchema = z.object({
  userId: z.string().min(1),
  minutes: z.number().int().min(1).max(TIMEOUT_MAX_MINUTES),
});

const banSchema = z.object({
  userId: z.string().min(1),
  reason: z.string().trim().max(BAN_REASON_MAX_LENGTH).default(''),
});

const voiceKickSchema = z.object({ userId: z.string().min(1) });

const messageSearchQuerySchema = z.string().trim().min(MESSAGE_SEARCH_QUERY_MIN_LENGTH).max(MESSAGE_SEARCH_QUERY_MAX_LENGTH);

function requireSession(request: Request, response: Response, next: NextFunction): void {
  const identity = getSession(request);
  if (!identity) {
    response.status(401).json({ error: 'Sessão ausente ou expirada.' });
    return;
  }
  const user = getUserById(identity.id);
  if (!user) {
    response.status(401).json({ error: 'Sessão inválida.' });
    return;
  }
  // Checado a cada requisição (não só no login) porque a sessão é um cookie
  // stateless de até 12h — sem isso, um usuário banido continuaria com
  // acesso completo até o cookie expirar sozinho.
  if (isBanned(user.id)) {
    clearSessionCookie(response);
    response.status(403).json({ error: 'Sua conta foi banida deste servidor.' });
    return;
  }
  response.locals.user = user;
  next();
}

function currentUser(response: Response): UserRecord {
  return response.locals.user as UserRecord;
}

function requirePermission(flag: number) {
  return (_request: Request, response: Response, next: NextFunction): void => {
    const user = currentUser(response);
    if (!hasPermission(getUserPermissionBitfield(user.id), flag)) {
      response.status(403).json({ error: 'Você não tem permissão para fazer isso.' });
      return;
    }
    next();
  };
}

function activeTimeoutRemainingMs(user: UserRecord): number {
  return user.timeoutUntil && user.timeoutUntil > Date.now() ? user.timeoutUntil - Date.now() : 0;
}

function rejectIfTimedOut(user: UserRecord, response: Response): boolean {
  const remaining = activeTimeoutRemainingMs(user);
  if (remaining <= 0) return false;
  const minutes = Math.ceil(remaining / 60_000);
  response.status(403).json({ error: `Você está em timeout por mais ${minutes} minuto(s).` });
  return true;
}

// Usado tanto pra "expulsar da voz" (KICK_MEMBERS) quanto pra forçar
// desconexão ao aplicar ban/timeout — procura em qual canal de voz (se
// algum) o usuário está agora, já que não guardamos esse estado localmente
// (a fonte da verdade é sempre o LiveKit).
async function findActiveRoomIdForUser(userId: string): Promise<string | null> {
  for (const channel of listVoiceChannels()) {
    try {
      const participants = await roomService.listParticipants(channel.id);
      if (participants.some((participant) => participant.identity === userId)) return channel.id;
    } catch {
      // Sala sem participantes ainda não existe no LiveKit — não é erro.
    }
  }
  return null;
}

async function forceDisconnectFromVoice(userId: string): Promise<void> {
  const roomId = await findActiveRoomIdForUser(userId);
  if (!roomId) return;
  try {
    await roomService.removeParticipant(roomId, userId);
  } catch (error) {
    console.error(`Falha ao forçar desconexão de voz de ${userId}:`, error);
  }
}

// Chamada tanto na abertura de um canal (fetch inicial) quanto por um laço
// periódico server-side (ver setInterval mais abaixo) — nos dois casos,
// qualquer mudança real é empurrada via WebSocket, então o cliente nunca
// mais precisa pollar isso diretamente.
async function refreshMusicBotTextMessage(textChannelId: string): Promise<void> {
  const existing = getMusicBotTextMessage(textChannelId);
  const voiceChannelId = existing?.musicCard?.voiceChannelId;
  if (!existing || !voiceChannelId) return;
  try {
    const stateResponse = await fetch(
      `${config.MUSIC_BOT_INTERNAL_URL}/state?channelId=${encodeURIComponent(voiceChannelId)}`,
      { signal: AbortSignal.timeout(2_000) },
    );
    if (!stateResponse.ok) return;
    const state = (await stateResponse.json()) as { nowPlaying?: unknown };
    if (!state.nowPlaying || typeof state.nowPlaying !== 'object') {
      if (deleteMusicBotTextMessage(textChannelId)) {
        broadcast({ type: 'TEXT_MESSAGE_DELETE', channelId: textChannelId, messageId: existing.id });
      }
      return;
    }
    const nowPlaying: MusicNowPlayingCard = {
      ...(state.nowPlaying as MusicNowPlayingCard),
      voiceChannelId,
    };
    const { message } = upsertMusicBotTextMessage(textChannelId, existing.text, nowPlaying);
    broadcast({ type: 'TEXT_MESSAGE_UPSERT', channelId: textChannelId, message });
  } catch {
    // Worker reiniciando: preserva o último card e tenta de novo no próximo ciclo.
  }
}

function toUserSession(user: UserRecord): UserSession {
  return {
    id: user.id,
    displayName: user.username,
    accentColor: user.accentColor,
    statusText: user.statusText,
    bio: user.bio,
    pronouns: user.pronouns,
    avatarUrl: user.avatarDataUrl,
    bannerUrl: user.bannerDataUrl,
    roleIds: getUserRoleIds(user.id),
    permissions: getUserPermissionBitfield(user.id),
    timeoutUntil: user.timeoutUntil,
  };
}

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.post('/api/auth/register', authLimiter, (request, response) => {
  const body = registerSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: 'Informe um nome de usuário e senha válidos.' });
    return;
  }

  if (!inviteMatches(body.data.inviteToken)) {
    response.status(401).json({ error: 'Convite inválido.' });
    return;
  }

  const username = body.data.username.replace(/\s+/g, ' ');
  if (getUserByUsername(username)) {
    response.status(409).json({ error: 'Esse nome de usuário já existe.' });
    return;
  }

  const user = createUser(username, body.data.password, body.data.accentColor);
  assignDefaultRole(user.id);
  const session = createSession(user.id, user.username);
  setSessionCookie(response, session);
  response.status(201).json({ user: toUserSession(user) });
});

app.post('/api/auth/login', authLimiter, (request, response) => {
  const body = loginSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: 'Informe usuário e senha.' });
    return;
  }

  const user = getUserByUsername(body.data.username);
  if (!user || !verifyPassword(user, body.data.password)) {
    response.status(401).json({ error: 'Usuário ou senha inválidos.' });
    return;
  }
  if (isBanned(user.id)) {
    response.status(403).json({ error: 'Sua conta foi banida deste servidor.' });
    return;
  }

  const session = createSession(user.id, user.username);
  setSessionCookie(response, session);
  response.status(200).json({ user: toUserSession(user) });
});

app.get('/api/session', requireSession, (_request, response) => {
  response.json({ user: toUserSession(currentUser(response)) });
});

app.delete('/api/session', (_request, response) => {
  clearSessionCookie(response);
  response.status(204).end();
});

app.get('/api/profile', requireSession, (_request, response) => {
  response.json({ user: toUserSession(currentUser(response)) });
});

app.patch('/api/profile', requireSession, (request, response) => {
  const body = profileSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: 'Perfil inválido.' });
    return;
  }

  const user = currentUser(response);
  updateUserProfile(
    user.id,
    body.data.accentColor,
    body.data.statusText,
    body.data.bio,
    body.data.pronouns,
    body.data.avatarUrl,
    body.data.bannerUrl,
  );
  response.json({
    user: toUserSession({
      ...user,
      accentColor: body.data.accentColor,
      statusText: body.data.statusText,
      bio: body.data.bio,
      pronouns: body.data.pronouns,
      avatarDataUrl: body.data.avatarUrl,
      bannerDataUrl: body.data.bannerUrl,
    }),
  });
});

app.get('/api/users/:id/avatar', requireSession, (request, response) => {
  const id = request.params.id;
  const user = typeof id === 'string' ? getUserById(id) : undefined;
  if (!user?.avatarDataUrl) {
    response.status(404).json({ error: 'Sem avatar.' });
    return;
  }
  response.json({ avatarUrl: user.avatarDataUrl });
});

app.get('/api/users/:id/profile', requireSession, (request, response) => {
  const id = request.params.id;
  const user = typeof id === 'string' ? getUserById(id) : undefined;
  if (!user) {
    response.status(404).json({ error: 'Usuário não encontrado.' });
    return;
  }
  response.json({ user: toUserSession(user) });
});

app.get('/api/config', requireSession, (_request, response) => {
  const payload: PublicConfig = {
    livekitUrl: config.LIVEKIT_PUBLIC_URL,
    channels: listVoiceChannels(),
  };
  response.json(payload);
});

app.get('/api/music/thumbnail', requireSession, async (request, response) => {
  const rawUrl = typeof request.query.url === 'string' ? request.query.url : '';
  try {
    const thumbnail = await fetchMusicThumbnail(rawUrl);
    response.setHeader('Content-Type', thumbnail.contentType);
    response.setHeader('Cache-Control', 'private, max-age=3600');
    response.setHeader('Content-Length', thumbnail.body.byteLength);
    response.send(Buffer.from(thumbnail.body));
  } catch (error) {
    console.error('Falha ao carregar thumbnail musical:', error);
    response.status(502).json({ error: 'N\u00e3o foi poss\u00edvel carregar a capa.' });
  }
});

app.get('/api/text-channels', requireSession, (_request, response) => {
  response.json({ channels: listTextChannels() });
});

app.post('/api/text-channels', requireSession, requirePermission(Permission.MANAGE_CHANNELS), channelCreateLimiter, (request, response) => {
  const body = channelSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: 'Informe um nome de canal válido.' });
    return;
  }

  const name = body.data.name.replace(/\s+/g, ' ');
  if (getTextChannelByName(name)) {
    response.status(409).json({ error: 'Já existe um canal com esse nome.' });
    return;
  }
  if (listTextChannels().length >= 50) {
    response.status(409).json({ error: 'O servidor atingiu o limite de 50 canais de texto.' });
    return;
  }

  const channel = createTextChannel(
    name,
    body.data.description || `Canal #${name}`,
    currentUser(response).id,
  );
  broadcast({ type: 'TEXT_CHANNEL_CREATE', channel });
  response.status(201).json({ channel });
});

app.get('/api/text-channels/:channelId/messages', requireSession, async (request, response) => {
  const channelId = request.params.channelId;
  if (typeof channelId !== 'string' || !getTextChannelById(channelId)) {
    response.status(404).json({ error: 'Canal de texto não encontrado.' });
    return;
  }
  await refreshMusicBotTextMessage(channelId);
  response.json({ messages: listTextMessages(channelId) });
});

app.post(
  '/api/text-channels/:channelId/messages',
  requireSession,
  textMessageLimiter,
  (request, response) => {
    const channelId = request.params.channelId;
    const body = textMessageSchema.safeParse(request.body);
    if (typeof channelId !== 'string' || !getTextChannelById(channelId)) {
      response.status(404).json({ error: 'Canal de texto não encontrado.' });
      return;
    }
    if (!body.success || (!body.data.text && !body.data.attachmentIds?.length)) {
      response.status(400).json({ error: 'Envie um texto (até 500 caracteres) ou pelo menos um anexo.' });
      return;
    }
    if (body.data.replyToMessageId && !getTextMessageById(channelId, body.data.replyToMessageId)) {
      response.status(404).json({ error: 'Mensagem original não encontrada.' });
      return;
    }
    if (rejectIfTimedOut(currentUser(response), response)) return;

    const message = createTextMessage(
      channelId,
      body.data.text,
      currentUser(response),
      body.data.replyToMessageId,
      body.data.attachmentIds,
    );
    broadcast({ type: 'TEXT_MESSAGE_CREATE', channelId, message });
    response.status(201).json({ message });
  },
);

app.patch(
  '/api/text-channels/:channelId/messages/:messageId',
  requireSession,
  textMessageLimiter,
  (request, response) => {
    const channelId = request.params.channelId;
    const messageId = request.params.messageId;
    const body = textMessageSchema.safeParse(request.body);
    if (typeof channelId !== 'string' || typeof messageId !== 'string' || !getTextChannelById(channelId)) {
      response.status(404).json({ error: 'Canal de texto não encontrado.' });
      return;
    }
    if (!body.success || !body.data.text) {
      response.status(400).json({ error: 'A mensagem deve ter entre 1 e 500 caracteres.' });
      return;
    }

    const result = editTextMessage(channelId, messageId, body.data.text, currentUser(response).id);
    if (!result.ok) {
      if (result.reason === 'FORBIDDEN') {
        response.status(403).json({ error: 'Você só pode editar suas próprias mensagens.' });
      } else {
        response.status(404).json({ error: 'Mensagem não encontrada.' });
      }
      return;
    }
    broadcast({ type: 'TEXT_MESSAGE_UPSERT', channelId, message: result.message });
    response.json({ message: result.message });
  },
);

app.delete('/api/text-channels/:channelId/messages/:messageId', requireSession, async (request, response) => {
  const channelId = request.params.channelId;
  const messageId = request.params.messageId;
  if (typeof channelId !== 'string' || typeof messageId !== 'string' || !getTextChannelById(channelId)) {
    response.status(404).json({ error: 'Canal de texto não encontrado.' });
    return;
  }

  const user = currentUser(response);
  const canManageMessages = hasPermission(getUserPermissionBitfield(user.id), Permission.MANAGE_MESSAGES);
  // Captura os anexos ANTES de apagar — o ON DELETE CASCADE já limpa as
  // linhas de message_attachments junto com a mensagem, então depois não
  // haveria mais como saber quais objetos existiam no MinIO pra remover.
  const attachments = getAttachmentRecordsForMessage(messageId);
  const result = deleteTextMessage(channelId, messageId, user.id, canManageMessages);
  if (!result.ok) {
    if (result.reason === 'FORBIDDEN') {
      response.status(403).json({ error: 'Você só pode apagar suas próprias mensagens.' });
    } else {
      response.status(404).json({ error: 'Mensagem não encontrada.' });
    }
    return;
  }
  await Promise.all(
    attachments.map((attachment) =>
      deleteAttachmentObject(attachment.objectKey).catch((error) => {
        console.error(`Falha ao remover objeto de anexo ${attachment.objectKey} do MinIO:`, error);
      }),
    ),
  );
  broadcast({ type: 'TEXT_MESSAGE_DELETE', channelId, messageId });
  response.status(204).end();
});

app.get('/api/text-channels/:channelId/messages/pins', requireSession, (request, response) => {
  const channelId = request.params.channelId;
  if (typeof channelId !== 'string' || !getTextChannelById(channelId)) {
    response.status(404).json({ error: 'Canal de texto não encontrado.' });
    return;
  }
  response.json({ messages: listPinnedMessages(channelId) });
});

app.get('/api/text-channels/:channelId/messages/search', requireSession, (request, response) => {
  const channelId = request.params.channelId;
  if (typeof channelId !== 'string' || !getTextChannelById(channelId)) {
    response.status(404).json({ error: 'Canal de texto não encontrado.' });
    return;
  }
  const query = messageSearchQuerySchema.safeParse(request.query.q);
  if (!query.success) {
    response.status(400).json({ error: `Digite pelo menos ${MESSAGE_SEARCH_QUERY_MIN_LENGTH} caracteres pra buscar.` });
    return;
  }
  response.json({ messages: searchTextMessages(channelId, query.data, MESSAGE_SEARCH_RESULTS_LIMIT) });
});

// Upload em duas etapas (igual o fluxo real do Discord): o arquivo sobe
// pra cá primeiro e fica "pendente" (message_id NULL, ver attachments.ts),
// o cliente já pode pré-visualizar via o mesmo GET /api/attachments/:id/...
// abaixo, e só quando a mensagem de verdade é enviada (POST .../messages
// com attachmentIds) é que o anexo é vinculado. Uploads nunca vinculados são
// varridos periodicamente (ver setInterval mais abaixo).
app.post(
  '/api/text-channels/:channelId/attachments',
  requireSession,
  uploadLimiter,
  handleAttachmentUpload,
  async (request, response) => {
    const channelId = request.params.channelId;
    if (typeof channelId !== 'string' || !getTextChannelById(channelId)) {
      response.status(404).json({ error: 'Canal de texto não encontrado.' });
      return;
    }
    const user = currentUser(response);
    if (rejectIfTimedOut(user, response)) return;
    if (!request.file) {
      response.status(400).json({ error: 'Nenhum arquivo enviado.' });
      return;
    }

    const filename = sanitizeFilename(request.file.originalname);
    const contentType = request.file.mimetype || 'application/octet-stream';
    const objectKey = `${randomUUID()}/${filename}`;
    try {
      await uploadAttachmentObject(objectKey, request.file.buffer, contentType);
    } catch (error) {
      console.error('Falha ao enviar anexo para o storage de objetos:', error);
      response.status(503).json({ error: 'Não foi possível enviar o arquivo agora. Tente novamente.' });
      return;
    }

    const attachment = createPendingAttachment({
      channelId,
      objectKey,
      filename,
      contentType,
      sizeBytes: request.file.size,
      uploadedBy: user.id,
    });
    response.status(201).json({
      attachment: {
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        url: `/api/attachments/${attachment.id}/${encodeURIComponent(attachment.filename)}`,
      },
    });
  },
);

function buildContentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Serve tanto anexos já vinculados a uma mensagem (qualquer autenticado pode
// ver, igual o resto do chat) quanto o próprio upload pendente de quem
// acabou de enviar (pré-visualização antes de mandar a mensagem). Decide
// inline vs. download forçado no servidor, nunca confiando no que o cliente
// pediu — é essa política que evita servir um arquivo malicioso disfarçado
// de imagem como HTML/SVG a partir da nossa própria origem (ver
// ATTACHMENT_INLINE_IMAGE_TYPES no pacote compartilhado).
app.get('/api/attachments/:attachmentId/:filename', requireSession, async (request, response) => {
  const attachmentId = request.params.attachmentId;
  const attachment = typeof attachmentId === 'string' ? getAttachmentRecordById(attachmentId) : undefined;
  const user = currentUser(response);
  if (!attachment || (attachment.messageId === null && attachment.uploadedBy !== user.id)) {
    response.status(404).json({ error: 'Anexo não encontrado.' });
    return;
  }

  try {
    const objectStream = await getAttachmentObjectStream(attachment.objectKey);
    const inline = (ATTACHMENT_INLINE_IMAGE_TYPES as readonly string[]).includes(attachment.contentType);
    response.setHeader('Content-Type', attachment.contentType);
    response.setHeader('Content-Length', attachment.sizeBytes);
    response.setHeader('Content-Disposition', buildContentDisposition(inline ? 'inline' : 'attachment', attachment.filename));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    objectStream.on('error', (error) => {
      console.error(`Falha ao ler objeto de anexo ${attachment.objectKey} do storage:`, error);
      if (!response.headersSent) response.status(503).end();
    });
    objectStream.pipe(response);
  } catch (error) {
    console.error(`Falha ao buscar anexo ${attachment.objectKey} no storage:`, error);
    response.status(503).json({ error: 'Não foi possível carregar o arquivo agora.' });
  }
});

app.post(
  '/api/text-channels/:channelId/messages/:messageId/pin',
  requireSession,
  requirePermission(Permission.MANAGE_MESSAGES),
  textMessageLimiter,
  (request, response) => {
    const channelId = request.params.channelId;
    const messageId = request.params.messageId;
    if (typeof channelId !== 'string' || typeof messageId !== 'string' || !getTextChannelById(channelId)) {
      response.status(404).json({ error: 'Canal de texto não encontrado.' });
      return;
    }
    const result = pinTextMessage(channelId, messageId, currentUser(response).id);
    if (!result.ok) {
      if (result.reason === 'ALREADY_PINNED') {
        response.status(409).json({ error: 'Essa mensagem já está fixada.' });
      } else if (result.reason === 'LIMIT_REACHED') {
        response.status(409).json({ error: 'Esse canal já atingiu o limite de 50 mensagens fixadas.' });
      } else {
        response.status(404).json({ error: 'Mensagem não encontrada.' });
      }
      return;
    }
    broadcast({ type: 'TEXT_MESSAGE_UPSERT', channelId, message: result.message });
    response.json({ message: result.message });
  },
);

app.delete(
  '/api/text-channels/:channelId/messages/:messageId/pin',
  requireSession,
  requirePermission(Permission.MANAGE_MESSAGES),
  textMessageLimiter,
  (request, response) => {
    const channelId = request.params.channelId;
    const messageId = request.params.messageId;
    if (typeof channelId !== 'string' || typeof messageId !== 'string' || !getTextChannelById(channelId)) {
      response.status(404).json({ error: 'Canal de texto não encontrado.' });
      return;
    }
    const result = unpinTextMessage(channelId, messageId);
    if (!result.ok) {
      response.status(404).json({ error: 'Essa mensagem não está fixada.' });
      return;
    }
    broadcast({ type: 'TEXT_MESSAGE_UPSERT', channelId, message: result.message });
    response.status(204).end();
  },
);

app.post(
  '/api/text-channels/:channelId/messages/:messageId/reactions',
  requireSession,
  reactionLimiter,
  (request, response) => {
    const channelId = request.params.channelId;
    const messageId = request.params.messageId;
    const body = reactionSchema.safeParse(request.body);
    if (
      typeof channelId !== 'string' ||
      typeof messageId !== 'string' ||
      !getTextChannelById(channelId) ||
      !getTextMessageById(channelId, messageId)
    ) {
      response.status(404).json({ error: 'Mensagem não encontrada.' });
      return;
    }
    if (!body.success) {
      response.status(400).json({ error: 'Emoji não suportado.' });
      return;
    }
    if (rejectIfTimedOut(currentUser(response), response)) return;

    const userId = currentUser(response).id;
    addReaction(messageId, body.data.emoji, userId);
    broadcast({ type: 'TEXT_MESSAGE_REACTION_ADD', channelId, messageId, emoji: body.data.emoji, userId });
    response.status(204).end();
  },
);

app.delete(
  '/api/text-channels/:channelId/messages/:messageId/reactions/:emoji',
  requireSession,
  reactionLimiter,
  (request, response) => {
    const channelId = request.params.channelId;
    const messageId = request.params.messageId;
    const emoji = request.params.emoji;
    if (
      typeof channelId !== 'string' ||
      typeof messageId !== 'string' ||
      !getTextChannelById(channelId) ||
      !getTextMessageById(channelId, messageId) ||
      !isValidReactionEmoji(emoji)
    ) {
      response.status(404).json({ error: 'Mensagem ou reação não encontrada.' });
      return;
    }

    const userId = currentUser(response).id;
    removeReaction(messageId, emoji, userId);
    broadcast({ type: 'TEXT_MESSAGE_REACTION_REMOVE', channelId, messageId, emoji, userId });
    response.status(204).end();
  },
);

// Compartilhada entre GET /api/rooms (fetch inicial/reconexão) e o webhook
// do LiveKit abaixo (que dispara ROOM_STATE_UPDATE via WebSocket sempre que
// alguém entra/sai de voz — sem isso não haveria como saber que o estado
// mudou, já que quem entra direto no LiveKit não passa pela nossa API).
async function computeRoomSummary(channel: VoiceChannel): Promise<RoomSummary> {
  const participants = await roomService.listParticipants(channel.id);
  return {
    ...channel,
    participants: participants.map((participant) => {
      const metadata = parseParticipantMetadata(participant.metadata);
      const microphoneTrack = participant.tracks.find((track) => track.source === TrackSource.MICROPHONE);
      return {
        identity: participant.identity,
        name: participant.name || participant.identity,
        participantType: metadata?.participantType ?? 'HUMAN',
        isSharingScreen: participant.tracks.some((track) => track.source === TrackSource.SCREEN_SHARE),
        isMuted: microphoneTrack?.muted ?? true,
      };
    }),
  };
}

app.get('/api/rooms', requireSession, async (_request, response) => {
  const channels = listVoiceChannels();
  try {
    const activeRoomNames = new Set(
      (await roomService.listRooms(channels.map((channel) => channel.id))).map(
        (room) => room.name,
      ),
    );
    const rooms: RoomSummary[] = await Promise.all(
      channels.map((channel) =>
        activeRoomNames.has(channel.id)
          ? computeRoomSummary(channel)
          : Promise.resolve({ ...channel, participants: [] }),
      ),
    );
    response.json({ rooms, livekitAvailable: true });
  } catch (error) {
    console.error('LiveKit indisponível ao consultar salas:', error);
    response.json({
      rooms: channels.map((channel) => ({ ...channel, participants: [] })),
      livekitAvailable: false,
    });
  }
});

app.post('/api/voice-channels', requireSession, requirePermission(Permission.MANAGE_CHANNELS), channelCreateLimiter, (request, response) => {
  const body = channelSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: 'Informe um nome de canal válido.' });
    return;
  }

  const name = body.data.name.replace(/\s+/g, ' ');
  if (getVoiceChannelByName(name)) {
    response.status(409).json({ error: 'Já existe um canal de voz com esse nome.' });
    return;
  }
  if (listVoiceChannels().length >= 50) {
    response.status(409).json({ error: 'O servidor atingiu o limite de 50 canais de voz.' });
    return;
  }

  const channel = createVoiceChannel(name, body.data.description || `Canal #${name}`, currentUser(response).id);
  broadcast({ type: 'VOICE_CHANNEL_CREATE', channel });
  response.status(201).json({ channel });
});

app.delete('/api/voice-channels/:channelId', requireSession, requirePermission(Permission.MANAGE_CHANNELS), (request, response) => {
  const channelId = request.params.channelId;
  if (typeof channelId !== 'string' || !getVoiceChannelById(channelId)) {
    response.status(404).json({ error: 'Canal de voz não encontrado.' });
    return;
  }
  if (listVoiceChannels().length <= 1) {
    response.status(409).json({ error: 'O servidor precisa de pelo menos um canal de voz.' });
    return;
  }
  deleteVoiceChannel(channelId);
  broadcast({ type: 'VOICE_CHANNEL_DELETE', channelId });
  response.status(204).end();
});

app.get('/api/soundboard', requireSession, (_request, response) => {
  response.json({ sounds: listSoundboardSounds() });
});

app.post('/api/soundboard', requireSession, channelCreateLimiter, (request, response) => {
  const body = soundboardSoundSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: 'Som inválido — verifique nome, emoji e duração (máx. 5,5s).' });
    return;
  }
  if (listSoundboardSounds().length >= 100) {
    response.status(409).json({ error: 'O servidor atingiu o limite de 100 sons no soundboard.' });
    return;
  }
  if (rejectIfTimedOut(currentUser(response), response)) return;

  const sound = createSoundboardSound(
    body.data.name,
    body.data.emoji,
    body.data.audioDataUrl,
    body.data.durationMs,
    currentUser(response),
  );
  broadcast({ type: 'SOUNDBOARD_SOUND_CREATE', sound });
  response.status(201).json({ sound });
});

app.delete('/api/soundboard/:soundId', requireSession, (request, response) => {
  const soundId = request.params.soundId;
  if (typeof soundId !== 'string' || !getSoundboardSoundById(soundId)) {
    response.status(404).json({ error: 'Som não encontrado.' });
    return;
  }
  const user = currentUser(response);
  const canManageSoundboard = hasPermission(getUserPermissionBitfield(user.id), Permission.MANAGE_SOUNDBOARD);
  if (!deleteSoundboardSound(soundId, user.id, canManageSoundboard)) {
    response.status(403).json({ error: 'Você só pode apagar sons que você mesmo enviou.' });
    return;
  }
  broadcast({ type: 'SOUNDBOARD_SOUND_DELETE', soundId });
  response.status(204).end();
});

app.get('/api/roles', requireSession, (_request, response) => {
  response.json({ roles: listRoles() });
});

app.post('/api/roles', requireSession, requirePermission(Permission.MANAGE_ROLES), roleLimiter, (request, response) => {
  const body = roleCreateSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: 'Cargo inválido — verifique nome, cor e permissões.' });
    return;
  }
  const requesterPosition = getUserHighestPosition(currentUser(response).id);
  if (requesterPosition <= 0) {
    response.status(403).json({ error: 'Você precisa de um cargo com posição maior que @everyone para criar cargos.' });
    return;
  }
  if (getRoleByName(body.data.name)) {
    response.status(409).json({ error: 'Já existe um cargo com esse nome.' });
    return;
  }
  // Todo cargo novo nasce logo abaixo do cargo mais alto de quem criou —
  // sem UI de reordenar posições (fora de escopo, ver DISCORD_PARITY_PLAN.md),
  // isso garante que quem criou sempre consiga editar/apagar o que criou.
  const position = requesterPosition - 1;
  const role = createRole(body.data.name, body.data.color, body.data.permissions, position, body.data.hoist);
  broadcast({ type: 'ROLE_CREATE', role });
  response.status(201).json({ role });
});

app.patch('/api/roles/:roleId', requireSession, requirePermission(Permission.MANAGE_ROLES), roleLimiter, (request, response) => {
  const roleId = request.params.roleId;
  const existing = typeof roleId === 'string' ? getRoleById(roleId) : undefined;
  if (!existing) {
    response.status(404).json({ error: 'Cargo não encontrado.' });
    return;
  }
  const requesterPosition = getUserHighestPosition(currentUser(response).id);
  if (existing.position >= requesterPosition) {
    response.status(403).json({ error: 'Você só pode editar cargos com posição menor que a sua.' });
    return;
  }
  const body = roleUpdateSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: 'Cargo inválido — verifique nome, cor e permissões.' });
    return;
  }
  if (body.data.name) {
    const duplicate = getRoleByName(body.data.name);
    if (duplicate && duplicate.id !== existing.id) {
      response.status(409).json({ error: 'Já existe um cargo com esse nome.' });
      return;
    }
  }
  const result = updateRole(roleId as string, body.data);
  if (!result.ok) {
    response.status(404).json({ error: 'Cargo não encontrado.' });
    return;
  }
  broadcast({ type: 'ROLE_UPDATE', role: result.role });
  response.json({ role: result.role });
});

app.delete('/api/roles/:roleId', requireSession, requirePermission(Permission.MANAGE_ROLES), (request, response) => {
  const roleId = request.params.roleId;
  const existing = typeof roleId === 'string' ? getRoleById(roleId) : undefined;
  if (!existing) {
    response.status(404).json({ error: 'Cargo não encontrado.' });
    return;
  }
  const requesterPosition = getUserHighestPosition(currentUser(response).id);
  if (existing.position >= requesterPosition) {
    response.status(403).json({ error: 'Você só pode apagar cargos com posição menor que a sua.' });
    return;
  }
  const result = deleteRole(roleId as string);
  if (!result.ok) {
    if (result.reason === 'IMMUTABLE') {
      response.status(400).json({ error: 'O cargo @everyone não pode ser apagado.' });
    } else {
      response.status(404).json({ error: 'Cargo não encontrado.' });
    }
    return;
  }
  broadcast({ type: 'ROLE_DELETE', roleId: roleId as string });
  response.status(204).end();
});

app.put(
  '/api/roles/:roleId/members/:userId',
  requireSession,
  requirePermission(Permission.MANAGE_ROLES),
  roleLimiter,
  (request, response) => {
    const roleId = request.params.roleId;
    const userId = request.params.userId;
    const role = typeof roleId === 'string' ? getRoleById(roleId) : undefined;
    const targetUser = typeof userId === 'string' ? getUserById(userId) : undefined;
    if (!role || !targetUser || roleId === EVERYONE_ROLE_ID) {
      response.status(404).json({ error: 'Cargo ou membro não encontrado.' });
      return;
    }
    const requesterPosition = getUserHighestPosition(currentUser(response).id);
    if (role.position >= requesterPosition) {
      response.status(403).json({ error: 'Você só pode atribuir cargos com posição menor que a sua.' });
      return;
    }
    assignRole(userId as string, roleId as string);
    const roleIds = getUserRoleIds(userId as string);
    broadcast({ type: 'MEMBER_ROLES_UPDATE', userId: userId as string, roleIds });
    response.status(204).end();
  },
);

app.delete(
  '/api/roles/:roleId/members/:userId',
  requireSession,
  requirePermission(Permission.MANAGE_ROLES),
  roleLimiter,
  (request, response) => {
    const roleId = request.params.roleId;
    const userId = request.params.userId;
    const role = typeof roleId === 'string' ? getRoleById(roleId) : undefined;
    if (!role || roleId === EVERYONE_ROLE_ID) {
      response.status(404).json({ error: 'Cargo não encontrado.' });
      return;
    }
    const requesterPosition = getUserHighestPosition(currentUser(response).id);
    if (role.position >= requesterPosition) {
      response.status(403).json({ error: 'Você só pode remover cargos com posição menor que a sua.' });
      return;
    }
    unassignRole(userId as string, roleId as string);
    const roleIds = getUserRoleIds(userId as string);
    broadcast({ type: 'MEMBER_ROLES_UPDATE', userId: userId as string, roleIds });
    response.status(204).end();
  },
);

app.get('/api/members', requireSession, (_request, response) => {
  response.json({ members: listMembers() });
});

app.post(
  '/api/moderation/timeout',
  requireSession,
  requirePermission(Permission.MODERATE_MEMBERS),
  moderationLimiter,
  async (request, response) => {
    const body = timeoutSchema.safeParse(request.body);
    if (!body.success) {
      response.status(400).json({ error: 'Informe o membro e a duração do timeout (1 a 10080 minutos).' });
      return;
    }
    const user = currentUser(response);
    if (!getUserById(body.data.userId)) {
      response.status(404).json({ error: 'Membro não encontrado.' });
      return;
    }
    const requesterPosition = getUserHighestPosition(user.id);
    const targetPosition = getUserHighestPosition(body.data.userId);
    const authorization = authorizeModerationAction(user.id, requesterPosition, body.data.userId, targetPosition);
    if (!authorization.ok) {
      response.status(403).json({
        error: authorization.reason === 'SELF'
          ? 'Você não pode aplicar timeout em si mesmo.'
          : 'Você só pode silenciar membros com posição de cargo menor que a sua.',
      });
      return;
    }
    const timeoutUntil = Date.now() + body.data.minutes * 60_000;
    setUserTimeout(body.data.userId, timeoutUntil);
    await forceDisconnectFromVoice(body.data.userId);
    broadcast({ type: 'MEMBER_TIMEOUT_UPDATE', userId: body.data.userId, timeoutUntil });
    response.json({ timeoutUntil });
  },
);

app.delete(
  '/api/moderation/timeout/:userId',
  requireSession,
  requirePermission(Permission.MODERATE_MEMBERS),
  moderationLimiter,
  (request, response) => {
    const userId = request.params.userId;
    const targetUser = typeof userId === 'string' ? getUserById(userId) : undefined;
    if (!targetUser) {
      response.status(404).json({ error: 'Membro não encontrado.' });
      return;
    }
    const requesterPosition = getUserHighestPosition(currentUser(response).id);
    const targetPosition = getUserHighestPosition(userId as string);
    const authorization = authorizeModerationAction(currentUser(response).id, requesterPosition, userId as string, targetPosition);
    if (!authorization.ok) {
      response.status(403).json({
        error: authorization.reason === 'SELF'
          ? 'Você não pode remover seu próprio timeout.'
          : 'Você só pode remover timeout de membros com posição de cargo menor que a sua.',
      });
      return;
    }
    setUserTimeout(userId as string, null);
    broadcast({ type: 'MEMBER_TIMEOUT_UPDATE', userId: userId as string, timeoutUntil: null });
    response.status(204).end();
  },
);

app.get('/api/moderation/bans', requireSession, requirePermission(Permission.BAN_MEMBERS), (_request, response) => {
  response.json({ bans: listBans() });
});

app.post(
  '/api/moderation/bans',
  requireSession,
  requirePermission(Permission.BAN_MEMBERS),
  moderationLimiter,
  async (request, response) => {
    const body = banSchema.safeParse(request.body);
    if (!body.success) {
      response.status(400).json({ error: 'Informe o membro a ser banido.' });
      return;
    }
    const user = currentUser(response);
    if (!getUserById(body.data.userId)) {
      response.status(404).json({ error: 'Membro não encontrado.' });
      return;
    }
    const requesterPosition = getUserHighestPosition(user.id);
    const targetPosition = getUserHighestPosition(body.data.userId);
    const authorization = authorizeModerationAction(user.id, requesterPosition, body.data.userId, targetPosition);
    if (!authorization.ok) {
      response.status(403).json({
        error: authorization.reason === 'SELF'
          ? 'Você não pode banir a si mesmo.'
          : 'Você só pode banir membros com posição de cargo menor que a sua.',
      });
      return;
    }
    banUser(body.data.userId, body.data.reason, user.id);
    await forceDisconnectFromVoice(body.data.userId);
    broadcast({ type: 'MEMBER_BANNED', userId: body.data.userId });
    disconnectUser(body.data.userId);
    response.status(204).end();
  },
);

app.delete(
  '/api/moderation/bans/:userId',
  requireSession,
  requirePermission(Permission.BAN_MEMBERS),
  moderationLimiter,
  (request, response) => {
    const userId = request.params.userId;
    if (typeof userId !== 'string' || !isBanned(userId)) {
      response.status(404).json({ error: 'Esse membro não está banido.' });
      return;
    }
    unbanUser(userId);
    broadcast({ type: 'MEMBER_UNBANNED', userId });
    response.status(204).end();
  },
);

app.post(
  '/api/moderation/voice-kick',
  requireSession,
  requirePermission(Permission.KICK_MEMBERS),
  moderationLimiter,
  async (request, response) => {
    const body = voiceKickSchema.safeParse(request.body);
    if (!body.success) {
      response.status(400).json({ error: 'Informe o membro a ser expulso.' });
      return;
    }
    const user = currentUser(response);
    const requesterPosition = getUserHighestPosition(user.id);
    const targetPosition = getUserHighestPosition(body.data.userId);
    const authorization = authorizeModerationAction(user.id, requesterPosition, body.data.userId, targetPosition);
    if (!authorization.ok) {
      response.status(403).json({
        error: authorization.reason === 'SELF'
          ? 'Você não pode expulsar a si mesmo.'
          : 'Você só pode expulsar membros com posição de cargo menor que a sua.',
      });
      return;
    }
    const roomId = await findActiveRoomIdForUser(body.data.userId);
    if (!roomId) {
      response.status(404).json({ error: 'Esse membro não está em nenhuma chamada de voz agora.' });
      return;
    }
    await roomService.removeParticipant(roomId, body.data.userId);
    response.status(204).end();
  },
);

const webhookReceiver = new WebhookReceiver(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
const ROOM_STATE_WEBHOOK_EVENTS = new Set([
  'participant_joined',
  'participant_left',
  'room_started',
  'room_finished',
]);

app.post('/api/livekit/webhook', express.raw({ type: '*/*' }), async (request, response) => {
  let event;
  try {
    event = await webhookReceiver.receive((request.body as Buffer).toString('utf8'), request.headers.authorization);
  } catch (error) {
    console.error('Webhook do LiveKit rejeitado:', error);
    response.status(401).end();
    return;
  }

  const roomName = event.room?.name;
  const channel = roomName ? getVoiceChannelById(roomName) : undefined;
  if (channel && ROOM_STATE_WEBHOOK_EVENTS.has(event.event)) {
    try {
      const room = event.event === 'room_finished' ? { ...channel, participants: [] } : await computeRoomSummary(channel);
      broadcast({ type: 'ROOM_STATE_UPDATE', room });
    } catch (error) {
      console.error('Falha ao recalcular estado da sala após webhook:', error);
    }
  }
  response.status(200).end();
});

app.post('/api/rooms/:roomId/participants/:identity/disconnect', requireSession, async (request, response) => {
  const parsed = disconnectParticipantSchema.safeParse({
    roomId: request.params.roomId,
    identity: request.params.identity,
  });
  const room = parsed.success ? getVoiceChannelById(parsed.data.roomId) : undefined;
  if (!parsed.success || !room) {
    response.status(400).json({ error: 'Canal de voz inv\u00e1lido.' });
    return;
  }
  const user = currentUser(response);
  try {
    const participants = await roomService.listParticipants(room.id);
    const authorization = authorizeVoiceDisconnect({
      roomId: room.id,
      channels: listVoiceChannels(),
      requesterId: user.id,
      targetIdentity: parsed.data.identity,
      participantIdentities: participants.map(({ identity }) => identity),
    });
    if (!authorization.ok) {
      if (authorization.reason === 'REQUESTER_NOT_IN_ROOM') {
        response.status(403).json({ error: 'Você precisa estar nesse canal de voz para desconectar alguém.' });
      } else if (authorization.reason === 'TARGET_NOT_IN_ROOM') {
        response.status(404).json({ error: 'Participante não encontrado nesse canal.' });
      } else {
        response.status(400).json({ error: 'Canal de voz inválido.' });
      }
      return;
    }
    const target = participants.find((participant) => participant.identity === parsed.data.identity);
    if (!target) {
      response.status(404).json({ error: 'Participante não encontrado nesse canal.' });
      return;
    }
    if (target.identity === MUSIC_BOT_IDENTITY) {
      const botResponse = await fetch(`${config.MUSIC_BOT_INTERNAL_URL}/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: room.id }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!botResponse.ok) {
        // Fallback: força a remoção no LiveKit; o RoomEvent.Disconnected do bot
        // limpa a sessão interna do SausiMusic.
        await roomService.removeParticipant(room.id, target.identity);
      }
      for (const clearedChannelId of deleteMusicBotTextMessagesForVoiceChannel(room.id)) {
        broadcast({
          type: 'TEXT_MESSAGE_DELETE',
          channelId: clearedChannelId,
          messageId: `music-bot:${clearedChannelId}`,
        });
      }
    } else {
      await roomService.removeParticipant(room.id, target.identity);
    }
    response.status(204).end();
  } catch (error) {
    console.error('Falha ao desconectar participante:', error);
    response.status(503).json({ error: 'N\u00e3o foi poss\u00edvel desconectar o participante.' });
  }
});

app.post('/api/livekit/token', requireSession, async (request, response) => {
  const body = tokenSchema.safeParse(request.body);
  const room = body.success ? getVoiceChannelById(body.data.roomId) : undefined;

  if (!body.success || !room) {
    response.status(400).json({ error: 'Canal inválido.' });
    return;
  }
  if (rejectIfTimedOut(currentUser(response), response)) return;

  const user = currentUser(response);
  const metadata: HumanParticipantMetadata = {
    app: 'sausixudos',
    participantType: 'HUMAN',
    userId: user.id,
    accentColor: user.accentColor,
    statusText: user.statusText,
    // Atividade (jogo/mídia) é detectada em tempo real pelo app desktop, não
    // dá pra saber no momento de emitir o token — começa nula e é publicada
    // depois via room.localParticipant.setMetadata (por isso canUpdateOwnMetadata).
    activity: null,
  };
  const accessToken = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity: user.id,
    name: user.username,
    ttl: '10m',
    metadata: JSON.stringify(metadata),
  });
  accessToken.addGrant({
    room: room.id,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
  });

  const payload: LiveKitTokenResponse = {
    token: await accessToken.toJwt(),
    url: config.LIVEKIT_PUBLIC_URL,
  };
  response.json(payload);
});

app.post('/api/music/command', requireSession, async (request, response) => {
  const body = musicCommandSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: 'Comando musical inválido.' });
    return;
  }

  if (body.data.textChannelId && !getTextChannelById(body.data.textChannelId)) {
    response.status(404).json({ error: 'Canal de texto n\u00e3o encontrado.' });
    return;
  }

  const user = currentUser(response);
  try {
    const authorization = await authorizeMusicCommand({
      roomId: body.data.roomId,
      text: body.data.text,
      channels: listVoiceChannels(),
      requester: { id: user.id, displayName: user.username },
      listParticipantIdentities: async (roomName) =>
        (await roomService.listParticipants(roomName)).map(({ identity }) => identity),
    });
    if (!authorization.ok) {
      if (authorization.reason === 'VOICE_REQUIRED') {
        response.status(403).json({ error: 'Você precisa estar em um canal de voz para usar este comando.' });
      } else {
        response.status(400).json({ error: 'Comando musical ou canal inválido.' });
      }
      return;
    }
    console.log(
      `[API] music command authorized room=${authorization.command.channelId} channel=${authorization.command.channelId} user=${user.id}`,
    );

    const botResponse = await fetch(`${config.MUSIC_BOT_INTERNAL_URL}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authorization.command),
      signal: AbortSignal.timeout(30_000),
    });
    if (!botResponse.ok) {
      console.error(`SausiMusic rejeitou o comando com status ${botResponse.status}.`);
      response.status(502).json({ error: 'O SausiMusic não conseguiu processar o comando.' });
      return;
    }
    const botResult = (await botResponse.json()) as { message?: unknown; nowPlaying?: unknown };
    if (typeof botResult.message !== 'string') {
      response.status(502).json({ error: 'O SausiMusic retornou uma resposta inválida.' });
      return;
    }
    let nowPlaying: MusicNowPlayingCard | undefined;
    if (botResult.nowPlaying && typeof botResult.nowPlaying === 'object') {
      nowPlaying = {
        ...(botResult.nowPlaying as MusicNowPlayingCard),
        voiceChannelId: authorization.command.channelId,
      };
    }

    const payload: MusicCommandResponse = nowPlaying
      ? { message: botResult.message, nowPlaying }
      : { message: botResult.message };
    if (body.data.textChannelId) {
      if (nowPlaying) {
        const { message, clearedChannelIds } = upsertMusicBotTextMessage(
          body.data.textChannelId,
          botResult.message,
          nowPlaying,
        );
        payload.textMessage = message;
        broadcast({ type: 'TEXT_MESSAGE_UPSERT', channelId: body.data.textChannelId, message });
        for (const clearedChannelId of clearedChannelIds) {
          broadcast({
            type: 'TEXT_MESSAGE_DELETE',
            channelId: clearedChannelId,
            messageId: `music-bot:${clearedChannelId}`,
          });
        }
      } else if (
        authorization.command.command === 'stop' ||
        authorization.command.command === 'leave' ||
        authorization.command.command === 'nowplaying' ||
        (authorization.command.command === 'skip' && !nowPlaying)
      ) {
        const removed = deleteMusicBotTextMessagesForVoiceChannel(authorization.command.channelId);
        if (removed.length > 0) payload.removeTextMessage = true;
        for (const clearedChannelId of removed) {
          broadcast({
            type: 'TEXT_MESSAGE_DELETE',
            channelId: clearedChannelId,
            messageId: `music-bot:${clearedChannelId}`,
          });
        }
      }
    }
    response.json(payload);
  } catch (error) {
    console.error('Falha ao repassar comando para o SausiMusic:', error);
    response.status(503).json({ error: 'O SausiMusic está indisponível.' });
    return;
  }
});

app.use((_request, response) => {
  response.status(404).json({ error: 'Rota não encontrada.' });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(500).json({ error: 'Erro interno do servidor.' });
});

const MUSIC_CARD_RESYNC_INTERVAL_MS = 4_000;
// Mantém os cards de "tocando agora" atualizados (progresso, avanço natural
// de fila) sem o cliente precisar pollar — o único lugar onde ainda existe
// polling no sistema, e ele é inteiramente interno ao servidor agora.
setInterval(() => {
  for (const textChannelId of listActiveMusicBotChannelIds()) {
    void refreshMusicBotTextMessage(textChannelId);
  }
}, MUSIC_CARD_RESYNC_INTERVAL_MS);

const ORPHANED_ATTACHMENT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 horas
const ORPHANED_ATTACHMENT_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
// Arquivo escolhido/enviado mas cuja mensagem nunca foi mandada (usuário
// fechou a aba, trocou de canal, etc.) fica "pendente" pra sempre se
// ninguém limpar — varre e apaga tanto a linha quanto o objeto no MinIO.
setInterval(() => {
  for (const attachment of listOrphanedAttachments(ORPHANED_ATTACHMENT_MAX_AGE_MS)) {
    deleteAttachmentObject(attachment.objectKey)
      .catch((error) => console.error(`Falha ao limpar anexo órfão ${attachment.objectKey}:`, error))
      .finally(() => deleteAttachmentRecord(attachment.id));
  }
}, ORPHANED_ATTACHMENT_SWEEP_INTERVAL_MS);

const server = app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`Sausixudos API ouvindo na porta ${config.PORT}`);
});
void ensureAttachmentsBucket();
attachRealtime(server);
