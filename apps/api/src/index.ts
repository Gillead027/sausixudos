import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { z } from 'zod';
import {
  ACCENT_COLORS,
  BIO_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PRONOUNS_MAX_LENGTH,
  STATUS_TEXT_MAX_LENGTH,
  type LiveKitTokenResponse,
  type PublicConfig,
  type RoomSummary,
  type UserSession,
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
app.use(express.json({ limit: '16kb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' },
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

const profileSchema = z.object({
  accentColor: z.enum(ACCENT_COLORS),
  statusText: z.string().trim().max(STATUS_TEXT_MAX_LENGTH).default(''),
  bio: z.string().trim().max(BIO_MAX_LENGTH).default(''),
  pronouns: z.string().trim().max(PRONOUNS_MAX_LENGTH).default(''),
});

const tokenSchema = z.object({ roomId: z.string().min(1).max(32) });

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

function toUserSession(user: UserRecord): UserSession {
  return {
    id: user.id,
    displayName: user.username,
    accentColor: user.accentColor,
    statusText: user.statusText,
    bio: user.bio,
    pronouns: user.pronouns,
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
  updateUserProfile(user.id, body.data.accentColor, body.data.statusText, body.data.bio, body.data.pronouns);
  response.json({
    user: toUserSession({
      ...user,
      accentColor: body.data.accentColor,
      statusText: body.data.statusText,
      bio: body.data.bio,
      pronouns: body.data.pronouns,
    }),
  });
});

app.get('/api/config', requireSession, (_request, response) => {
  const payload: PublicConfig = {
    livekitUrl: config.LIVEKIT_PUBLIC_URL,
    channels: config.channels,
  };
  response.json(payload);
});

app.get('/api/rooms', requireSession, async (_request, response, next) => {
  try {
    const activeRoomNames = new Set(
      (await roomService.listRooms(config.channels.map((channel) => channel.id))).map(
        (room) => room.name,
      ),
    );
    const rooms: RoomSummary[] = await Promise.all(
      config.channels.map(async (channel) => {
        if (!activeRoomNames.has(channel.id)) return { ...channel, participants: [] };
        const participants = await roomService.listParticipants(channel.id);
        return {
          ...channel,
          participants: participants.map((participant) => ({
            identity: participant.identity,
            name: participant.name || participant.identity,
          })),
        };
      }),
    );
    response.json({ rooms, livekitAvailable: true });
  } catch (error) {
    console.error('LiveKit indisponível ao consultar salas:', error);
    response.json({
      rooms: config.channels.map((channel) => ({ ...channel, participants: [] })),
      livekitAvailable: false,
    });
  }
});

app.post('/api/livekit/token', requireSession, async (request, response) => {
  const body = tokenSchema.safeParse(request.body);
  const room = body.success
    ? config.channels.find((channel) => channel.id === body.data.roomId)
    : undefined;

  if (!body.success || !room) {
    response.status(400).json({ error: 'Canal inválido.' });
    return;
  }

  const user = currentUser(response);
  const accessToken = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity: user.id,
    name: user.username,
    ttl: '10m',
    metadata: JSON.stringify({
      app: 'sausixudos',
      accentColor: user.accentColor,
      statusText: user.statusText,
    }),
  });
  accessToken.addGrant({
    room: room.id,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const payload: LiveKitTokenResponse = {
    token: await accessToken.toJwt(),
    url: config.LIVEKIT_PUBLIC_URL,
  };
  response.json(payload);
});

app.use((_request, response) => {
  response.status(404).json({ error: 'Rota não encontrada.' });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(500).json({ error: 'Erro interno do servidor.' });
});

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`Sausixudos API ouvindo na porta ${config.PORT}`);
});
