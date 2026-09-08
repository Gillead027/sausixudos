import { createServer } from 'node:http';
import { dispose } from '@livekit/rtc-node';
import { isMusicBotCommandRequest } from '@sausixudos/shared';
import { BotVoiceParticipant, type MusicLog } from './botVoiceParticipant.js';
import { config } from './config.js';
import { MusicSessionManager } from './musicSession.js';
import { MusicProviderRegistry } from './musicProvider.js';
import { YouTubeProvider } from './youtubeProvider.js';
import { SpotifyProvider } from './spotifyProvider.js';
import { SoundCloudProvider } from './soundcloudProvider.js';
import { YtDlpClient } from './ytDlpClient.js';

const log: MusicLog = (event, context) => {
  const fields = Object.entries(context)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  console.log(`[MUSIC] ${event}${fields ? ` ${fields}` : ''}`);
};

const ytDlpClient = new YtDlpClient(config.YTDLP_PATH);
const soundcloudProvider = new SoundCloudProvider(ytDlpClient);
const youtubeProvider = new YouTubeProvider(
  ytDlpClient,
  soundcloudProvider,
  config.YOUTUBE_AUDIO_FALLBACK === 'true',
);
const providers = new MusicProviderRegistry([
  youtubeProvider,
  soundcloudProvider,
  new SpotifyProvider(soundcloudProvider),
], 'youtube', ['youtube', 'soundcloud']);
const djUserIds = new Set(config.MUSIC_DJ_USER_IDS.split(',').map((id) => id.trim()).filter(Boolean));

const sessionManager = new MusicSessionManager(
  (context, lifecycle) =>
    new BotVoiceParticipant({
      ...context,
      livekitUrl: config.LIVEKIT_INTERNAL_URL,
      apiKey: config.LIVEKIT_API_KEY,
      apiSecret: config.LIVEKIT_API_SECRET,
      ffmpegPath: config.FFMPEG_PATH,
      ytdlpPath: config.YTDLP_PATH,
      ytdlpPluginDir: config.YTDLP_PLUGIN_DIR,
      ytdlpPotBaseUrl: config.YTDLP_POT_BASE_URL,
      log,
      lifecycle,
    }),
  log,
  providers,
  djUserIds,
);

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        service: 'sausimusic',
        status: 'healthy',
        activeSessions: sessionManager.activeSessions,
      }),
    );
    return;
  }

  if (request.method !== 'POST' || request.url !== '/command') {
    response.writeHead(404).end();
    return;
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  request.on('data', (chunk: Buffer) => {
    receivedBytes += chunk.length;
    if (receivedBytes > 16_384) {
      response.writeHead(413).end();
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (response.headersSent) return;
    void (async () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          !isMusicBotCommandRequest(body) ||
          !config.channels.some((channel) => channel.id === body.channelId)
        ) {
          response.writeHead(400).end();
          return;
        }
        const result = await sessionManager.execute(body);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result));
      } catch (error) {
        log('command error', {
          error: error instanceof Error ? error.message : String(error),
        });
        response.writeHead(500).end();
      }
    })();
  });
});

server.listen(config.MUSIC_BOT_PORT, '0.0.0.0', () => {
  log('service ready', { port: config.MUSIC_BOT_PORT });
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('worker shutdown', { signal });
  server.close();
  await sessionManager.shutdown();
  dispose();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
