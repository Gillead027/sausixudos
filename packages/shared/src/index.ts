export const DISPLAY_NAME_MIN_LENGTH = 2;
export const DISPLAY_NAME_MAX_LENGTH = 24;
export const CHAT_MESSAGE_MAX_LENGTH = 500;
export const TEXT_CHANNEL_NAME_MAX_LENGTH = 32;
export const TEXT_CHANNEL_DESCRIPTION_MAX_LENGTH = 120;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;
export const STATUS_TEXT_MAX_LENGTH = 60;
export const BIO_MAX_LENGTH = 300;
export const PRONOUNS_MAX_LENGTH = 30;
export const AVATAR_DATA_URL_MAX_LENGTH = 400_000;
export const BANNER_DATA_URL_MAX_LENGTH = 1_100_000;
export const VOICE_CHAT_TOPIC = 'sausixudos-chat';
export const MUSIC_BOT_IDENTITY = 'music-bot';
export const MUSIC_BOT_DISPLAY_NAME = 'SausiMusic';
export const MUSIC_BOT_TRACK_NAME = 'sausimusic-test-tone';
export const MUSIC_PLAY_INPUT_MAX_LENGTH = 300;

export const ACCENT_COLORS = [
  '#4e7960',
  '#5c526b',
  '#566747',
  '#6b5548',
  '#45645f',
  '#684d52',
  '#4a6b8a',
  '#8a5a4a',
] as const;

export type AccentColor = (typeof ACCENT_COLORS)[number];

export interface UserSession {
  id: string;
  displayName: string;
  accentColor: AccentColor;
  statusText: string;
  bio: string;
  pronouns: string;
  avatarUrl: string;
  bannerUrl: string;
}

export interface VoiceChannel {
  id: string;
  name: string;
  description: string;
}

export interface AuthenticatedUserIdentity {
  id: string;
  displayName: string;
}

export type ParticipantType = 'HUMAN' | 'BOT';

export interface PlayingActivity {
  kind: 'playing';
  name: string;
}

export interface ListeningActivity {
  kind: 'listening';
  app: string;
  title: string;
  artist: string;
}

export type Activity = PlayingActivity | ListeningActivity;

export interface HumanParticipantMetadata {
  app: 'sausixudos';
  participantType: 'HUMAN';
  userId: string;
  accentColor: AccentColor;
  statusText: string;
  // Detectada localmente pelo app desktop (jogo em execução / mídia tocando
  // no Windows) e publicada ao vivo via room.localParticipant.setMetadata —
  // por isso é sempre null no metadata inicial do token (ver apps/api).
  activity: Activity | null;
}

export interface BotParticipantMetadata {
  app: 'sausixudos';
  participantType: 'BOT';
  botId: typeof MUSIC_BOT_IDENTITY;
}

export type ParticipantMetadata = HumanParticipantMetadata | BotParticipantMetadata;

function parseActivity(value: unknown): Activity | null {
  if (!value || typeof value !== 'object') return null;
  const activity = value as Record<string, unknown>;
  if (activity.kind === 'playing' && typeof activity.name === 'string') {
    return { kind: 'playing', name: activity.name };
  }
  if (
    activity.kind === 'listening' &&
    typeof activity.app === 'string' &&
    typeof activity.title === 'string' &&
    typeof activity.artist === 'string'
  ) {
    return { kind: 'listening', app: activity.app, title: activity.title, artist: activity.artist };
  }
  return null;
}

export function parseParticipantMetadata(value: string | undefined): ParticipantMetadata | null {
  if (!value) return null;
  try {
    const metadata = JSON.parse(value) as Record<string, unknown>;
    if (metadata.app !== 'sausixudos') return null;
    if (
      metadata.participantType === 'BOT' &&
      metadata.botId === MUSIC_BOT_IDENTITY
    ) {
      return {
        app: 'sausixudos',
        participantType: 'BOT',
        botId: MUSIC_BOT_IDENTITY,
      };
    }
    if (
      metadata.participantType === 'HUMAN' &&
      typeof metadata.userId === 'string' &&
      typeof metadata.accentColor === 'string' &&
      (ACCENT_COLORS as readonly string[]).includes(metadata.accentColor) &&
      typeof metadata.statusText === 'string'
    ) {
      return {
        app: 'sausixudos',
        participantType: 'HUMAN',
        userId: metadata.userId,
        accentColor: metadata.accentColor as AccentColor,
        statusText: metadata.statusText,
        activity: parseActivity(metadata.activity),
      };
    }
  } catch {
    // Metadata externa ou malformada não deve quebrar a lista de participantes.
  }
  return null;
}

export const MUSIC_COMMAND_ALIASES = {
  'play-file': 'play-file',
  'play-local': 'play-local',
  play: 'play',
  playlist: 'playlist',
  history: 'history',
  pause: 'pause',
  resume: 'resume',
  skip: 'skip',
  stop: 'stop',
  leave: 'leave',
  queue: 'queue',
  nowplaying: 'nowplaying',
  np: 'nowplaying',
  volume: 'volume',
  clear: 'clear',
} as const;

export type MusicCommandName = (typeof MUSIC_COMMAND_ALIASES)[keyof typeof MUSIC_COMMAND_ALIASES];
export type MusicCommandPrefix = '/' | '!';

export interface MusicCommandArgsByName {
  'play-file': Record<never, never>;
  'play-local': Record<never, never>;
  play: { input: string };
  playlist: { input: string };
  history: Record<never, never>;
  pause: Record<never, never>;
  resume: Record<never, never>;
  skip: Record<never, never>;
  stop: Record<never, never>;
  leave: Record<never, never>;
  queue: Record<never, never>;
  nowplaying: Record<never, never>;
  volume: { volume: number };
  clear: Record<never, never>;
}

export type ParsedMusicCommand = {
  [Name in MusicCommandName]: {
    name: Name;
    prefix: MusicCommandPrefix;
    args: MusicCommandArgsByName[Name];
  };
}[MusicCommandName];

/** Normaliza aliases e argumentos; a API ainda valida autenticação e voice state. */
export function parseMusicCommand(value: string): ParsedMusicCommand | null {
  const match = /^([/!])([a-z-]+)(?:\s+(.+))?$/i.exec(value.trim());
  if (!match) return null;
  const prefix = match[1] as MusicCommandPrefix;
  const alias = match[2]?.toLowerCase() as keyof typeof MUSIC_COMMAND_ALIASES | undefined;
  if (!alias || !Object.hasOwn(MUSIC_COMMAND_ALIASES, alias)) return null;
  const name = MUSIC_COMMAND_ALIASES[alias];
  const rawArgs = match[3]?.trim();

  if (name === 'play' || name === 'playlist') {
    if (!rawArgs || rawArgs.length > MUSIC_PLAY_INPUT_MAX_LENGTH) return null;
    return { name, prefix, args: { input: rawArgs } };
  }

  if (name === 'volume') {
    if (!rawArgs || !/^\d+$/.test(rawArgs)) return null;
    const volume = Number(rawArgs);
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) return null;
    return { name, prefix, args: { volume } };
  }

  if (rawArgs) return null;
  return { name, prefix, args: {} } as ParsedMusicCommand;
}

/**
 * Detecção leve para composers. A API continua responsável por autenticar o
 * usuário, validar o voice state e normalizar o comando definitivamente.
 */
export function isMusicCommandInput(value: string): boolean {
  const match = /^[/!]([a-z-]+)/i.exec(value.trim());
  const alias = match?.[1]?.toLowerCase();
  return Boolean(alias && Object.hasOwn(MUSIC_COMMAND_ALIASES, alias));
}

export interface MusicNowPlayingCard {
  title: string;
  author: string;
  providerId: string;
  durationMs: number;
  positionMs: number;
  requestedBy: string;
  state: string;
  volume: number;
  queueSize?: number;
  voiceChannelId?: string;
  thumbnailUrl?: string;
  webUrl?: string;
}

export interface MusicCommandResponse {
  message: string;
  nowPlaying?: MusicNowPlayingCard;
  textMessage?: TextMessage;
}

/** Contrato interno usado pela API para encaminhar um comando autenticado ao SausiMusic. */
interface MusicBotCommandRequestBase {
  channelId: string;
  requestedBy: AuthenticatedUserIdentity;
}

export type MusicBotCommandRequest = {
  [Name in MusicCommandName]: MusicBotCommandRequestBase & {
    command: Name;
    args: MusicCommandArgsByName[Name];
  };
}[MusicCommandName];

export function isMusicBotCommandRequest(value: unknown): value is MusicBotCommandRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MusicBotCommandRequest>;
  if (
    typeof candidate.channelId === 'string' &&
    typeof candidate.command === 'string' &&
    (Object.values(MUSIC_COMMAND_ALIASES) as string[]).includes(candidate.command) &&
    typeof candidate.args === 'object' &&
    candidate.args !== null &&
    typeof candidate.requestedBy === 'object' &&
    candidate.requestedBy !== null &&
    typeof candidate.requestedBy.id === 'string' &&
    typeof candidate.requestedBy.displayName === 'string'
  ) {
    if (candidate.command === 'play' || candidate.command === 'playlist') {
      const input = (candidate.args as { input?: unknown }).input;
      return Object.keys(candidate.args).length === 1 && typeof input === 'string' && input.trim().length > 0 && input.length <= MUSIC_PLAY_INPUT_MAX_LENGTH;
    }
    if (candidate.command === 'volume') {
      const volume = (candidate.args as { volume?: unknown }).volume;
      return (
        Object.keys(candidate.args).length === 1 &&
        Number.isInteger(volume) &&
        (volume as number) >= 0 &&
        (volume as number) <= 100
      );
    }
    return Object.keys(candidate.args).length === 0;
  }
  return false;
}

/** Mantém API e serviços usando a mesma definição dos canais de voz. */
export function parseVoiceChannels(value: string): VoiceChannel[] {
  const channels = value.split(',').map((entry) => {
    const [rawId, rawName, ...descriptionParts] = entry.split(':');
    const id = rawId?.trim() ?? '';
    const name = rawName?.trim() ?? '';
    const description = descriptionParts.join(':').trim();

    if (!/^[a-z0-9-]{1,32}$/.test(id) || !name || !description) {
      throw new Error(
        `Canal inválido "${entry}". Use id:nome:descrição e apenas a-z, 0-9 ou hífen no id.`,
      );
    }

    return { id, name, description };
  });

  if (channels.length === 0 || new Set(channels.map(({ id }) => id)).size !== channels.length) {
    throw new Error('VOICE_CHANNELS deve conter canais com ids únicos.');
  }

  return channels;
}

export interface RoomParticipantSummary {
  identity: string;
  name: string;
  participantType: ParticipantType;
  isSharingScreen: boolean;
  isMuted: boolean;
}

export interface RoomSummary extends VoiceChannel {
  participants: RoomParticipantSummary[];
}

export interface PublicConfig {
  livekitUrl: string;
  channels: VoiceChannel[];
}

export interface LiveKitTokenResponse {
  token: string;
  url: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: number;
  musicCard?: MusicNowPlayingCard;
}

export interface TextChannel {
  id: string;
  name: string;
  description: string;
  createdBy: string | null;
  createdAt: number;
}

export interface TextMessage {
  id: string;
  channelId: string;
  senderId: string;
  senderName: string;
  senderType: ParticipantType;
  text: string;
  sentAt: number;
  musicCard?: MusicNowPlayingCard;
}
