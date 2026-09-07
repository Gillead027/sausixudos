import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv({ path: new URL('../../../.env', import.meta.url), quiet: true });

const envSchema = z.object({
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(32),
  LIVEKIT_INTERNAL_URL: z.string().url().default('http://localhost:7880'),
  VOICE_CHANNELS: z.string().default(
    'geral:Geral:Conversa livre,jogos:Jogos:Partidas e squads,afk:AFK:Pausa rápida',
  ),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Configuração inválida:', z.prettifyError(parsed.error));
  process.exit(1);
}

function parseChannelIds(value: string): string[] {
  return value.split(',').map((entry) => entry.split(':')[0]?.trim() ?? '').filter(Boolean);
}

export const config = {
  ...parsed.data,
  channelIds: parseChannelIds(parsed.data.VOICE_CHANNELS),
};
