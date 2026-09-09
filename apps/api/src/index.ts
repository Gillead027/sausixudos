import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from 'livekit-server-sdk';
import { z } from 'zod';
import {
  ACCENT_COLORS,
  MUSIC_BOT_IDENTITY,
  AVATAR_DATA_URL_MAX_LENGTH,
  BANNER_DATA_URL_MAX_LENGTH,
  BIO_MAX_LENGTH,
  CHAT_MESSAGE_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PRONOUNS_MAX_LENGTH,
  STATUS_TEXT_MAX_LENGTH,
  TEXT_CHANNEL_DESCRIPTION_MAX_LENGTH,
  TEXT_CHANNEL_NAME_MAX_LENGTH,
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
import { createUser, getUserById, getUserByUsername, updateUserProfile, verifyPassword, type UserRecord } from './users.js';
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
  listTextChannels,
  listTextMessages,
} from './textChannels.js';
import { addReaction, isValidReactionEmoji, removeReaction } from './reactions.js';
import { authorizeMusicCommand } from './musicCommands.js';
import { fetchMusicThumbnail } from './musicThumbnails.js';
import { authorizeVoiceDisconnect } from './voiceModeration.js';
import { attachRealtime, broadcast } from './realtime.js';
import {
  createVoiceChannel,
  deleteVoiceChannel,
  getVoiceChannelById,
  getVoiceChannelByName,
  listVoiceChannels,
} from './voiceChannels.js';

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
  text: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_LENGTH),
  replyToMessageId: z.string().min(1).max(64).optional(),
});

const reactionSchema = z.object({
  emoji: z.string().refine(isValidReactionEmoji, 'Emoji não suportado.'),
});

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
  response.locals.user = user;
  next();
}

function currentUser(response: Response): UserRecord {
  return response.locals.user as UserRecord;
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

app.post('/api/text-channels', requireSession, channelCreateLimiter, (request, response) => {
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
    if (!body.success) {
      response.status(400).json({ error: 'A mensagem deve ter entre 1 e 500 caracteres.' });
      return;
    }
    if (body.data.replyToMessageId && !getTextMessageById(channelId, body.data.replyToMessageId)) {
      response.status(404).json({ error: 'Mensagem original não encontrada.' });
      return;
    }

    const message = createTextMessage(channelId, body.data.text, currentUser(response), body.data.replyToMessageId);
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
    if (!body.success) {
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

app.delete('/api/text-channels/:channelId/messages/:messageId', requireSession, (request, response) => {
  const channelId = request.params.channelId;
  const messageId = request.params.messageId;
  if (typeof channelId !== 'string' || typeof messageId !== 'string' || !getTextChannelById(channelId)) {
    response.status(404).json({ error: 'Canal de texto não encontrado.' });
    return;
  }

  const result = deleteTextMessage(channelId, messageId, currentUser(response).id);
  if (!result.ok) {
    if (result.reason === 'FORBIDDEN') {
      response.status(403).json({ error: 'Você só pode apagar suas próprias mensagens.' });
    } else {
      response.status(404).json({ error: 'Mensagem não encontrada.' });
    }
    return;
  }
  broadcast({ type: 'TEXT_MESSAGE_DELETE', channelId, messageId });
  response.status(204).end();
});

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

app.post('/api/voice-channels', requireSession, channelCreateLimiter, (request, response) => {
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

app.delete('/api/voice-channels/:channelId', requireSession, (request, response) => {
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

const server = app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`Sausixudos API ouvindo na porta ${config.PORT}`);
});
attachRealtime(server);
