import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { parseVoiceChannels } from '@sausixudos/shared';

loadEnv({ path: new URL('../../../.env', import.meta.url), quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  INVITE_TOKEN: z.string().min(8, 'INVITE_TOKEN deve ter pelo menos 8 caracteres'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET deve ter pelo menos 32 caracteres'),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(32, 'LIVEKIT_API_SECRET deve ter pelo menos 32 caracteres'),
  LIVEKIT_PUBLIC_URL: z.string().url(),
  LIVEKIT_INTERNAL_URL: z.string().url().default('http://localhost:7880'),
  MUSIC_BOT_INTERNAL_URL: z.string().url().default('http://music-bot:4100'),
  DB_PATH: z.string().default('./data/gillecord.db'),
  VOICE_CHANNELS: z.string().default(
    'geral:Geral:Conversa livre,jogos:Jogos:Partidas e squads,afk:AFK:Pausa rápida',
  ),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().int().min(1).max(65535).default(9000),
  MINIO_USE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  MINIO_ACCESS_KEY: z.string().min(1).default('sausixudos'),
  MINIO_SECRET_KEY: z.string().min(8).default('sausixudos-dev-secret'),
  MINIO_BUCKET: z.string().default('sausixudos-attachments'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Configuração inválida:', z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = {
  ...parsed.data,
  channels: parseVoiceChannels(parsed.data.VOICE_CHANNELS),
  isProduction: parsed.data.NODE_ENV === 'production',
};
