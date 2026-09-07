import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  type LocalTrackPublication,
  Room,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import { CHAT_MESSAGE_MAX_LENGTH, type ChatMessage } from '@sausixudos/shared';
import { config } from './config.js';
import { CHANNELS, FRAME_SAMPLES, SAMPLE_RATE, startAudioPipeline, type AudioPipeline } from './audioPipeline.js';

const BOT_IDENTITY = 'music-bot';
const BOT_NAME = 'Music Bot';
const CHAT_TOPIC = 'sausixudos-chat';
const IDLE_DISCONNECT_MS = 60_000;

interface QueueItem {
  url: string;
  requestedBy: string;
}

interface PlaybackState {
  channelId: string;
  pipeline: AudioPipeline;
  track: LocalAudioTrack;
  publication: LocalTrackPublication;
  paused: boolean;
}

const queue: QueueItem[] = [];
const rooms = new Map<string, Room>();
const idleTimers = new Map<string, NodeJS.Timeout>();
let playback: PlaybackState | null = null;

function cancelIdleDisconnect(channelId: string): void {
  const timer = idleTimers.get(channelId);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(channelId);
  }
}

function scheduleIdleDisconnect(channelId: string): void {
  cancelIdleDisconnect(channelId);
  idleTimers.set(
    channelId,
    setTimeout(() => {
      idleTimers.delete(channelId);
      void disconnectChannel(channelId);
    }, IDLE_DISCONNECT_MS),
  );
}

async function disconnectChannel(channelId: string): Promise<void> {
  if (playback?.channelId === channelId) return; // tocando de novo nesse meio-tempo, não desconecta
  const room = rooms.get(channelId);
  if (!room) return;
  rooms.delete(channelId);
  await room.disconnect().catch(() => {});
  console.log(`Bot de música saiu do canal "${channelId}" (ocioso).`);
}

async function mintToken(channelId: string): Promise<string> {
  const token = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity: BOT_IDENTITY,
    name: BOT_NAME,
    ttl: '24h',
  });
  token.addGrant({
    room: channelId,
    roomJoin: true,
    canPublish: true,
    canSubscribe: false,
    canPublishData: true,
  });
  return token.toJwt();
}

/** Conecta ao canal só quando alguém usa um comando nele — o bot não fica mais parado, mudo, em todo canal o tempo todo. */
async function getOrCreateRoom(channelId: string): Promise<Room> {
  const existing = rooms.get(channelId);
  if (existing) return existing;

  if (!config.channelIds.includes(channelId)) {
    throw new Error(`Canal "${channelId}" não configurado.`);
  }

  const room = new Room();
  const token = await mintToken(channelId);
  await room.connect(config.LIVEKIT_INTERNAL_URL, token, { autoSubscribe: false, dynacast: false });
  rooms.set(channelId, room);
  console.log(`Bot de música entrou no canal "${channelId}".`);
  return room;
}

async function reply(channelId: string, text: string): Promise<void> {
  const room = rooms.get(channelId);
  if (!room?.localParticipant) return;
  const message: ChatMessage = {
    id: randomUUID(),
    senderId: BOT_IDENTITY,
    senderName: BOT_NAME,
    text: text.slice(0, CHAT_MESSAGE_MAX_LENGTH),
    sentAt: Date.now(),
  };
  try {
    await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(message)), {
      reliable: true,
      topic: CHAT_TOPIC,
    });
  } catch (error) {
    console.error('Falha ao enviar mensagem do bot:', error);
  }
}

async function stopPlayback(): Promise<void> {
  if (!playback) return;
  const { channelId, pipeline, track, publication } = playback;
  playback = null;
  pipeline.stop();
  const room = rooms.get(channelId);
  if (room?.localParticipant && publication.sid) {
    await room.localParticipant.unpublishTrack(publication.sid).catch(() => {});
  }
  await track.close().catch(() => {});
}

async function playNext(channelId: string): Promise<void> {
  const next = queue.shift();
  if (!next) {
    await stopPlayback();
    scheduleIdleDisconnect(channelId);
    return;
  }
  cancelIdleDisconnect(channelId);

  const room = rooms.get(channelId);
  if (!room?.localParticipant) return;

  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const track = LocalAudioTrack.createAudioTrack('music', source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;

  let publication: LocalTrackPublication;
  try {
    publication = await room.localParticipant.publishTrack(track, options);
  } catch (error) {
    console.error('Falha ao publicar áudio:', error);
    await reply(channelId, 'Não consegui publicar o áudio agora. Tente de novo.');
    void playNext(channelId);
    return;
  }

  const pipeline = startAudioPipeline(
    next.url,
    (frame) => {
      if (playback?.paused) return;
      void source.captureFrame(new AudioFrame(frame, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES));
    },
    (error) => {
      if (error) {
        console.error('Erro na reprodução:', error);
        void reply(channelId, `⚠ Não consegui tocar esse link: ${error.message}`);
      }
      void playNext(channelId);
    },
  );

  playback = { channelId, pipeline, track, publication, paused: false };
  await reply(channelId, `🎵 Tocando agora: ${next.url} (pedido por ${next.requestedBy})`);
}

async function handleCommand(channelId: string, senderName: string, text: string): Promise<void> {
  const [command, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');

  switch (command) {
    case '/play': {
      if (!arg) {
        await reply(channelId, 'Use /play <link do YouTube>.');
        return;
      }
      if (playback && playback.channelId !== channelId) {
        await reply(channelId, 'O bot já está tocando em outro canal agora.');
        return;
      }
      queue.push({ url: arg, requestedBy: senderName });
      if (!playback) {
        await playNext(channelId);
      } else {
        await reply(channelId, `Adicionado à fila: ${arg}`);
      }
      return;
    }
    case '/pause': {
      if (playback?.channelId === channelId) {
        playback.paused = true;
        await reply(channelId, '⏸ Pausado.');
      }
      return;
    }
    case '/resume': {
      if (playback?.channelId === channelId) {
        playback.paused = false;
        await reply(channelId, '▶ Retomado.');
      }
      return;
    }
    case '/skip': {
      if (playback?.channelId === channelId) {
        await reply(channelId, '⏭ Pulando…');
        playback.pipeline.stop();
      }
      return;
    }
    case '/stop': {
      if (playback?.channelId === channelId) {
        queue.length = 0;
        await stopPlayback();
        scheduleIdleDisconnect(channelId);
        await reply(channelId, '⏹ Parado.');
      }
      return;
    }
    case '/queue': {
      if (queue.length === 0) {
        await reply(channelId, 'Fila vazia.');
      } else {
        await reply(channelId, `Fila: ${queue.map((item, index) => `${index + 1}. ${item.url}`).join(' | ')}`);
      }
      return;
    }
    default:
      return;
  }
}

interface CommandRequestBody {
  channelId?: unknown;
  text?: unknown;
  requestedBy?: unknown;
}

function startCommandServer(): void {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/command') {
      response.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CommandRequestBody;
          const { channelId, text, requestedBy } = body;
          if (typeof channelId !== 'string' || typeof text !== 'string' || typeof requestedBy !== 'string') {
            response.writeHead(400).end();
            return;
          }
          await getOrCreateRoom(channelId);
          await handleCommand(channelId, requestedBy, text);
          response.writeHead(204).end();
        } catch (error) {
          console.error('Falha ao processar comando recebido:', error);
          response.writeHead(500).end();
        }
      })();
    });
  });

  server.listen(config.MUSIC_BOT_PORT, () => {
    console.log(`Bot de música aguardando comandos na porta ${config.MUSIC_BOT_PORT}.`);
  });
}

startCommandServer();
