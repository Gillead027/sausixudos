import { randomUUID } from 'node:crypto';
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  type LocalTrackPublication,
  Room,
  RoomEvent,
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
let playback: PlaybackState | null = null;

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
    return;
  }

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

async function connectToChannel(channelId: string): Promise<void> {
  const room = new Room();
  const token = await mintToken(channelId);
  await room.connect(config.LIVEKIT_INTERNAL_URL, token, { autoSubscribe: false, dynacast: false });
  rooms.set(channelId, room);

  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (topic !== CHAT_TOPIC || !participant) return;
    try {
      const message = JSON.parse(new TextDecoder().decode(payload)) as ChatMessage;
      if (typeof message.text !== 'string' || !message.text.startsWith('/')) return;
      void handleCommand(channelId, message.senderName || participant.identity, message.text);
    } catch {
      // Ignora payloads que não são mensagens de chat válidas.
    }
  });

  console.log(`Bot de música conectado ao canal "${channelId}".`);
}

async function main(): Promise<void> {
  for (const channelId of config.channelIds) {
    await connectToChannel(channelId);
  }
}

void main();
