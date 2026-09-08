import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseVoiceChannels } from '@sausixudos/shared';

loadEnv({ path: new URL('../../../.env', import.meta.url), quiet: true });
const defaultYtDlpPluginDir = fileURLToPath(new URL('../../../.tools/yt-dlp-plugins/', import.meta.url));

const envSchema = z.object({
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(32),
  LIVEKIT_INTERNAL_URL: z.string().url().default('http://localhost:7880'),
  MUSIC_BOT_PORT: z.coerce.number().int().positive().default(4100),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  YTDLP_PATH: z.string().min(1).default('yt-dlp'),
  YTDLP_PLUGIN_DIR: z.string().min(1).default(defaultYtDlpPluginDir),
  YTDLP_POT_BASE_URL: z.string().url().default('http://127.0.0.1:4416'),
  MUSIC_DJ_USER_IDS: z.string().default(''),
  VOICE_CHANNELS: z.string().default(
    'geral:Geral:Conversa livre,jogos:Jogos:Partidas e squads,afk:AFK:Pausa rápida',
  ),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Configuração inválida:', z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = {
  ...parsed.data,
  channels: parseVoiceChannels(parsed.data.VOICE_CHANNELS),
};
