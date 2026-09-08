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
import {
  CHAT_MESSAGE_MAX_LENGTH,
  MUSIC_BOT_DISPLAY_NAME,
  MUSIC_BOT_IDENTITY,
  MUSIC_BOT_TRACK_NAME,
  VOICE_CHAT_TOPIC,
  isMusicBotCommandRequest,
  type ChatMessage,
  type MusicBotCommandRequest,
} from '@sausixudos/shared';
import { config } from './config.js';
import {
  CHANNELS,
  FRAME_SAMPLES,
  SAMPLE_RATE,
  startAudioPipeline,
  startTestTonePipeline,
  type AudioPipeline,
} from './audioPipeline.js';

const IDLE_DISCONNECT_MS = 60_000;
const TEST_TONE_DURATION_MS = 6000;
const FRAME_DURATION_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;

interface QueueItem {
  id: string;
  kind: 'url' | 'test-tone';
  value: string;
  label: string;
  requestedBy: string;
  durationMs?: number;
}

interface PlaybackState {
  id: string;
  channelId: string;
  item: QueueItem;
  pipeline: AudioPipeline;
  track: LocalAudioTrack;
  publication: LocalTrackPublication;
  paused: boolean;
  positionMs: number;
}

interface LegacyCommandRequestBody {
  channelId?: unknown;
  text?: unknown;
  requestedBy?: unknown;
}

type IncomingCommand =
  | { kind: 'canonical'; body: MusicBotCommandRequest }
  | { kind: 'legacy'; channelId: string; text: string; requestedBy: string };

const queues = new Map<string, QueueItem[]>();
const rooms = new Map<string, Room>();
const idleTimers = new Map<string, NodeJS.Timeout>();
const volumes = new Map<string, number>();
let playback: PlaybackState | null = null;
let testToneSequence = 0;

function queueFor(channelId: string): QueueItem[] {
  const existing = queues.get(channelId);
  if (existing) return existing;
  const created: QueueItem[] = [];
  queues.set(channelId, created);
  return created;
}

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
  if (playback?.channelId === channelId) return;
  const room = rooms.get(channelId);
  if (!room) return;
  rooms.delete(channelId);
  await room.disconnect().catch(() => {});
  console.log(`[MUSIC] session left room="${channelId}"`);
}

async function mintToken(channelId: string): Promise<string> {
  const token = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity: MUSIC_BOT_IDENTITY,
    name: MUSIC_BOT_DISPLAY_NAME,
    ttl: '10m',
    metadata: JSON.stringify({
      app: 'sausixudos',
      participantType: 'BOT',
      botId: MUSIC_BOT_IDENTITY,
    }),
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

async function getOrCreateRoom(channelId: string): Promise<Room> {
  const existing = rooms.get(channelId);
  if (existing) return existing;

  if (!config.channelIds.includes(channelId)) {
    throw new Error(`Canal "${channelId}" não configurado.`);
  }

  console.log(`[MUSIC] joining room room="${channelId}" channel="${channelId}"`);
  const room = new Room();
  const token = await mintToken(channelId);
  await room.connect(config.LIVEKIT_INTERNAL_URL, token, { autoSubscribe: false, dynacast: false });
  rooms.set(channelId, room);
  console.log(`[MUSIC] bot participant connected room="${channelId}" channel="${channelId}"`);
  return room;
}

async function reply(channelId: string, text: string): Promise<void> {
  const room = rooms.get(channelId);
  if (!room?.localParticipant) return;
  const message: ChatMessage = {
    id: randomUUID(),
    senderId: MUSIC_BOT_IDENTITY,
    senderName: MUSIC_BOT_DISPLAY_NAME,
    text: text.slice(0, CHAT_MESSAGE_MAX_LENGTH),
    sentAt: Date.now(),
  };
  try {
    await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(message)), {
      reliable: true,
      topic: VOICE_CHAT_TOPIC,
    });
  } catch (error) {
    console.error('Falha ao enviar mensagem do bot:', error);
  }
}

function applyVolume(frame: Int16Array, channelId: string): Int16Array {
  const volume = volumes.get(channelId) ?? 100;
  if (volume === 100) return frame;
  if (volume === 0) return new Int16Array(frame.length);
  const gain = volume / 100;
  const scaled = new Int16Array(frame.length);
  for (let index = 0; index < frame.length; index += 1) {
    const sample = Math.round(frame[index] * gain);
    scaled[index] = Math.max(-32768, Math.min(32767, sample));
  }
  return scaled;
}

async function stopPlayback(): Promise<PlaybackState | null> {
  if (!playback) return null;
  const current = playback;
  playback = null;
  current.pipeline.stop();
  const room = rooms.get(current.channelId);
  if (room?.localParticipant && current.publication.sid) {
    await room.localParticipant.unpublishTrack(current.publication.sid).catch(() => {});
  }
  await current.track.close().catch(() => {});
  console.log(
    `[MUSIC] track unpublished room="${current.channelId}" channel="${current.channelId}" track="${current.publication.sid ?? ''}"`,
  );
  return current;
}

async function handleNaturalEnd(playbackId: string, error: Error | null): Promise<void> {
  if (!playback || playback.id !== playbackId) return;
  const { channelId, item } = playback;
  await stopPlayback();
  if (error) {
    console.error(`[MUSIC] playback failed room="${channelId}" trackId="${item.id}"`, error);
    await reply(channelId, `⚠ Não consegui tocar ${item.label}: ${error.message}`);
  } else {
    console.log(`[MUSIC] playback finished room="${channelId}" channel="${channelId}" trackId="${item.id}"`);
  }
  await playNext(channelId);
}

async function startQueueItem(channelId: string, item: QueueItem): Promise<void> {
  cancelIdleDisconnect(channelId);
  const room = await getOrCreateRoom(channelId);
  if (!room.localParticipant) throw new Error('Participante local do bot indisponível.');

  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const track = LocalAudioTrack.createAudioTrack(MUSIC_BOT_TRACK_NAME, source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;

  const publication = await room.localParticipant.publishTrack(track, options);
  const playbackId = randomUUID();

  const onFrame = (frame: Int16Array) => {
    const current = playback;
    if (!current || current.id !== playbackId || current.paused) return;
    current.positionMs += FRAME_DURATION_MS;
    void source.captureFrame(new AudioFrame(applyVolume(frame, channelId), SAMPLE_RATE, CHANNELS, FRAME_SAMPLES));
  };

  const onEnd = (error: Error | null) => {
    void handleNaturalEnd(playbackId, error);
  };

  const pipeline = item.kind === 'test-tone'
    ? startTestTonePipeline(
        onFrame,
        onEnd,
        () => Boolean(playback?.id === playbackId && playback.paused),
        item.durationMs ?? TEST_TONE_DURATION_MS,
      )
    : startAudioPipeline(item.value, onFrame, onEnd);

  playback = {
    id: playbackId,
    channelId,
    item,
    pipeline,
    track,
    publication,
    paused: false,
    positionMs: 0,
  };

  console.log(
    `[MUSIC] audio track published room="${channelId}" channel="${channelId}" track="${publication.sid ?? ''}"`,
  );
  console.log(`[MUSIC] playback started room="${channelId}" channel="${channelId}" session="${playbackId}"`);
  await reply(channelId, `🎵 Tocando agora: ${item.label} (pedido por ${item.requestedBy})`);
}

async function playNext(channelId: string): Promise<void> {
  const next = queueFor(channelId).shift();
  if (!next) {
    scheduleIdleDisconnect(channelId);
    console.log(`[MUSIC] session idle room="${channelId}"`);
    return;
  }
  console.log(`[MUSIC] advancing queue room="${channelId}" trackId="${next.id}"`);
  try {
    await startQueueItem(channelId, next);
  } catch (error) {
    console.error(`[MUSIC] failed to start track room="${channelId}" trackId="${next.id}"`, error);
    await reply(channelId, 'Não consegui publicar o áudio agora. Tente de novo.');
    await playNext(channelId);
  }
}

async function enqueueItem(channelId: string, item: QueueItem): Promise<{ started: boolean; position: number }> {
  if (playback && playback.channelId !== channelId) {
    throw new Error('BUSY_OTHER_CHANNEL');
  }
  await getOrCreateRoom(channelId);
  if (!playback) {
    await startQueueItem(channelId, item);
    return { started: true, position: 0 };
  }
  const queue = queueFor(channelId);
  queue.push(item);
  console.log(`[MUSIC] track queued room="${channelId}" trackId="${item.id}" position=${queue.length}`);
  return { started: false, position: queue.length };
}

function makeTestTone(requestedBy: string): QueueItem {
  testToneSequence += 1;
  return {
    id: randomUUID(),
    kind: 'test-tone',
    value: `test-tone-${testToneSequence}`,
    label: `Test Tone #${testToneSequence}`,
    requestedBy,
    durationMs: TEST_TONE_DURATION_MS,
  };
}

function makeUrlItem(url: string, requestedBy: string): QueueItem {
  return {
    id: randomUUID(),
    kind: 'url',
    value: url,
    label: url,
    requestedBy,
  };
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

async function handleCanonicalCommand(body: MusicBotCommandRequest): Promise<string> {
  const channelId = body.channelId;
  const requester = body.requestedBy.displayName;
  console.log(
    `[MUSIC] command received room="${channelId}" channel="${channelId}" command="${body.command}" user="${body.requestedBy.id}"`,
  );

  switch (body.command) {
    case 'play-file': {
      const item = makeTestTone(requester);
      try {
        const result = await enqueueItem(channelId, item);
        return result.started
          ? `SausiMusic começou a tocar ${item.label}.`
          : `Adicionado à fila: ${item.label}. Posição: ${result.position}.`;
      } catch (error) {
        if (error instanceof Error && error.message === 'BUSY_OTHER_CHANNEL') {
          return 'O SausiMusic já está tocando em outro canal agora.';
        }
        throw error;
      }
    }
    case 'pause': {
      if (!playback || playback.channelId !== channelId || playback.paused) return 'Não há reprodução ativa para pausar.';
      playback.paused = true;
      console.log(`[MUSIC] playback paused room="${channelId}"`);
      return 'Reprodução pausada.';
    }
    case 'resume': {
      if (!playback || playback.channelId !== channelId || !playback.paused) return 'Não há reprodução pausada para retomar.';
      playback.paused = false;
      console.log(`[MUSIC] playback resumed room="${channelId}"`);
      return 'Reprodução retomada.';
    }
    case 'skip': {
      if (!playback || playback.channelId !== channelId) return 'Não há faixa para pular.';
      await stopPlayback();
      console.log(`[MUSIC] playback skipped room="${channelId}"`);
      await playNext(channelId);
      return playback?.channelId === channelId
        ? `Faixa pulada. Tocando agora: ${playback.item.label}.`
        : 'Faixa pulada. A fila terminou.';
    }
    case 'stop': {
      queueFor(channelId).length = 0;
      if (playback?.channelId === channelId) await stopPlayback();
      scheduleIdleDisconnect(channelId);
      console.log(`[MUSIC] playback stopped room="${channelId}"`);
      return 'Reprodução parada e fila limpa.';
    }
    case 'leave': {
      queueFor(channelId).length = 0;
      if (playback?.channelId === channelId) await stopPlayback();
      cancelIdleDisconnect(channelId);
      await disconnectChannel(channelId);
      return 'SausiMusic saiu do canal de voz.';
    }
    case 'queue': {
      const queue = queueFor(channelId);
      const current = playback?.channelId === channelId ? playback.item.label : null;
      if (!current && queue.length === 0) return 'Fila vazia.';
      const lines = [current ? `Tocando agora: ${current}` : 'Nada tocando no momento.'];
      if (queue.length > 0) {
        lines.push(`Fila: ${queue.map((item, index) => `${index + 1}. ${item.label}`).join(' | ')}`);
      } else {
        lines.push('Fila vazia.');
      }
      return lines.join('\n');
    }
    case 'nowplaying': {
      if (!playback || playback.channelId !== channelId) return 'Nada tocando no momento.';
      const duration = playback.item.durationMs;
      const position = formatTime(playback.positionMs);
      return [
        `Tocando agora: ${playback.item.label}`,
        `Solicitado por: ${playback.item.requestedBy}`,
        `Estado: ${playback.paused ? 'PAUSED' : 'PLAYING'}`,
        `Posição: ${position}${duration ? ` / ${formatTime(duration)}` : ''}`,
        `Volume: ${volumes.get(channelId) ?? 100}%`,
      ].join('\n');
    }
    case 'volume': {
      volumes.set(channelId, body.args.volume);
      console.log(`[MUSIC] volume changed room="${channelId}" volume=${body.args.volume}`);
      return `Volume do SausiMusic ajustado para ${body.args.volume}%.`;
    }
    case 'clear': {
      queueFor(channelId).length = 0;
      console.log(`[MUSIC] queue cleared room="${channelId}"`);
      return 'Fila limpa.';
    }
  }
}

/** Compatibilidade temporária com o protocolo antigo usado antes do relay canônico da API. */
async function handleLegacyCommand(channelId: string, senderName: string, text: string): Promise<string> {
  const [command, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');

  switch (command) {
    case '/play': {
      if (!arg) return 'Use /play <link do YouTube>.';
      try {
        const item = makeUrlItem(arg, senderName);
        const result = await enqueueItem(channelId, item);
        return result.started ? `Tocando agora: ${arg}` : `Adicionado à fila: ${arg}`;
      } catch (error) {
        if (error instanceof Error && error.message === 'BUSY_OTHER_CHANNEL') {
          return 'O bot já está tocando em outro canal agora.';
        }
        throw error;
      }
    }
    case '/pause':
      if (playback?.channelId === channelId && !playback.paused) playback.paused = true;
      return '⏸ Pausado.';
    case '/resume':
      if (playback?.channelId === channelId && playback.paused) playback.paused = false;
      return '▶ Retomado.';
    case '/skip':
      if (playback?.channelId === channelId) {
        await stopPlayback();
        await playNext(channelId);
      }
      return '⏭ Pulado.';
    case '/stop':
      queueFor(channelId).length = 0;
      if (playback?.channelId === channelId) await stopPlayback();
      scheduleIdleDisconnect(channelId);
      return '⏹ Parado.';
    case '/queue': {
      const queue = queueFor(channelId);
      return queue.length === 0
        ? 'Fila vazia.'
        : `Fila: ${queue.map((item, index) => `${index + 1}. ${item.label}`).join(' | ')}`;
    }
    default:
      return 'Comando não reconhecido.';
  }
}

function parseIncomingCommand(value: unknown): IncomingCommand | null {
  if (isMusicBotCommandRequest(value)) return { kind: 'canonical', body: value };
  if (!value || typeof value !== 'object') return null;
  const legacy = value as LegacyCommandRequestBody;
  if (
    typeof legacy.channelId === 'string' &&
    typeof legacy.text === 'string' &&
    typeof legacy.requestedBy === 'string'
  ) {
    return {
      kind: 'legacy',
      channelId: legacy.channelId,
      text: legacy.text,
      requestedBy: legacy.requestedBy,
    };
  }
  return null;
}

function writeJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function startCommandServer(): void {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      writeJson(response, 200, {
        service: 'sausimusic',
        status: 'healthy',
        activeSessions: rooms.size,
      });
      return;
    }

    if (request.method !== 'POST' || request.url !== '/command') {
      writeJson(response, 404, { error: 'Rota não encontrada.' });
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 64 * 1024) chunks.push(chunk);
    });
    request.on('end', () => {
      void (async () => {
        try {
          if (bytes > 64 * 1024) {
            writeJson(response, 413, { error: 'Payload muito grande.' });
            return;
          }
          const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          const command = parseIncomingCommand(raw);
          if (!command) {
            writeJson(response, 400, { error: 'Contrato de comando inválido.' });
            return;
          }

          let message: string;
          if (command.kind === 'canonical') {
            message = await handleCanonicalCommand(command.body);
          } else {
            await getOrCreateRoom(command.channelId);
            message = await handleLegacyCommand(command.channelId, command.requestedBy, command.text);
          }

          writeJson(response, 200, { message });
        } catch (error) {
          console.error('Falha ao processar comando recebido:', error);
          writeJson(response, 500, { error: 'Falha ao processar comando.' });
        }
      })();
    });
  });

  server.listen(config.MUSIC_BOT_PORT, '0.0.0.0', () => {
    console.log(`[MUSIC] service ready port=${config.MUSIC_BOT_PORT}`);
  });
}

startCommandServer();
