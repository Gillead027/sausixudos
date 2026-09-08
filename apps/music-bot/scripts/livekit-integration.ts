import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AudioStream,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  dispose,
  type Participant,
  type RemoteParticipant,
} from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import {
  MUSIC_BOT_IDENTITY,
  parseMusicCommand,
  parseParticipantMetadata,
  type MusicBotCommandRequest,
} from '@sausixudos/shared';
import { authorizeMusicCommand } from '../../api/src/musicCommands.js';
import { BotVoiceParticipant } from '../src/botVoiceParticipant.js';
import { config } from '../src/config.js';
import { MusicSessionManager } from '../src/musicSession.js';

const roomName = `sausimusic-integration-${randomUUID().slice(0, 8)}`;
const subscribers = [new Room(), new Room()];
const requester = { id: 'integration-client-1', displayName: 'Cliente 1' };

interface AudioMonitor {
  nonSilentFrames: number;
  subscribedTracks: number;
  unsubscribedTracks: number;
  botDisconnected: boolean;
  botSpoke: boolean;
  botSpeaking: boolean;
  streamTasks: Promise<void>[];
}

async function mintSubscriberToken(identity: string): Promise<string> {
  const token = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity,
    name: identity,
    ttl: '5m',
    metadata: JSON.stringify({
      app: 'sausixudos',
      participantType: 'HUMAN',
      userId: identity,
      accentColor: '#4e7960',
      statusText: '',
    }),
  });
  token.addGrant({ room: roomName, roomJoin: true, canPublish: false, canSubscribe: true });
  return token.toJwt();
}

function command(text: string): MusicBotCommandRequest {
  const parsed = parseMusicCommand(text);
  assert.ok(parsed, `Comando de integração inválido: ${text}`);
  return {
    channelId: roomName,
    command: parsed.name,
    args: parsed.args,
    requestedBy: requester,
  } as MusicBotCommandRequest;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForCondition(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`Timeout aguardando ${label}.`));
      }
    }, 20);
  });
}

function monitorBotAudio(room: Room, clientName: string): AudioMonitor {
  const monitor: AudioMonitor = {
    nonSilentFrames: 0,
    subscribedTracks: 0,
    unsubscribedTracks: 0,
    botDisconnected: false,
    botSpoke: false,
    botSpeaking: false,
    streamTasks: [],
  };

  room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
    monitor.botSpeaking = speakers.some(({ identity }) => identity === MUSIC_BOT_IDENTITY);
    if (monitor.botSpeaking) monitor.botSpoke = true;
  });
  room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
    if (participant.identity === MUSIC_BOT_IDENTITY) monitor.botDisconnected = true;
  });
  room.on(RoomEvent.TrackUnsubscribed, (_track, _publication, participant) => {
    if (participant.identity === MUSIC_BOT_IDENTITY) monitor.unsubscribedTracks += 1;
  });
  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant: RemoteParticipant) => {
    if (participant.identity !== MUSIC_BOT_IDENTITY) return;
    assert.ok(track instanceof RemoteAudioTrack, `${clientName} recebeu track não-áudio.`);
    assert.equal(parseParticipantMetadata(participant.metadata)?.participantType, 'BOT');
    monitor.subscribedTracks += 1;
    const task = (async () => {
      const reader = new AudioStream(track, {
        sampleRate: 48_000,
        numChannels: 1,
        frameSizeMs: 20,
      }).getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) return;
          if (result.value.data.some((sample) => sample !== 0)) monitor.nonSilentFrames += 1;
        }
      } finally {
        reader.releaseLock();
      }
    })();
    monitor.streamTasks.push(task);
  });

  return monitor;
}

const manager = new MusicSessionManager(
  (context, lifecycle) =>
    new BotVoiceParticipant({
      ...context,
      livekitUrl: config.LIVEKIT_INTERNAL_URL,
      apiKey: config.LIVEKIT_API_KEY,
      apiSecret: config.LIVEKIT_API_SECRET,
      ffmpegPath: config.FFMPEG_PATH,
      log: (event, values) => console.log(`[INTEGRATION] ${event}`, values),
      lifecycle,
    }),
  (event, values) => console.log(`[INTEGRATION] ${event}`, values),
);
const roomService = new RoomServiceClient(
  config.LIVEKIT_INTERNAL_URL,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);
const monitors = subscribers.map((room, index) => monitorBotAudio(room, `cliente-${index + 1}`));

try {
  await Promise.all(
    subscribers.map(async (room, index) => {
      const identity = `integration-client-${index + 1}`;
      await room.connect(config.LIVEKIT_INTERNAL_URL, await mintSubscriberToken(identity), {
        autoSubscribe: true,
        dynacast: false,
      });
    }),
  );

  const authorization = await authorizeMusicCommand({
    roomId: roomName,
    text: '/play-file',
    channels: [{ id: roomName, name: 'Integração', description: 'Teste isolado' }],
    requester,
    listParticipantIdentities: async (canonicalRoomName) =>
      (await roomService.listParticipants(canonicalRoomName)).map(({ identity }) => identity),
  });
  assert.equal(authorization.ok, true);
  assert.ok(authorization.ok);

  assert.match((await manager.execute(authorization.command)).message, /começou a tocar/);
  await waitForCondition(
    () => monitors.every(({ nonSilentFrames }) => nonSilentFrames >= 10),
    'áudio inicial nos dois clientes',
  );
  await waitForCondition(() => monitors.every(({ botSpoke }) => botSpoke), 'speaking nos dois clientes');

  await manager.execute(command('/play-file'));
  assert.equal(manager.getSession(roomName)?.queue.length, 1);

  assert.match((await manager.execute(command('/pause'))).message, /pausada/i);
  const pausedPosition = manager.getSession(roomName)?.positionMs;
  await waitForCondition(
    () => monitors.every(({ botSpeaking }) => !botSpeaking),
    'speaking cessar após pause',
    3_000,
  );
  assert.equal(manager.getSession(roomName)?.positionMs, pausedPosition);
  const framesAfterPauseDrain = monitors.map(({ nonSilentFrames }) => nonSilentFrames);
  await delay(400);
  assert.ok(
    monitors.every((monitor, index) => monitor.nonSilentFrames <= (framesAfterPauseDrain[index] ?? 0) + 1),
    'pause continuou entregando áudio não silencioso',
  );

  assert.match((await manager.execute(command('/resume'))).message, /retomada/i);
  await waitForCondition(
    () => monitors.every((monitor, index) => monitor.nonSilentFrames >= (framesAfterPauseDrain[index] ?? 0) + 5),
    'áudio após resume',
  );
  await waitForCondition(() => monitors.every(({ botSpeaking }) => botSpeaking), 'speaking após resume');
  assert.ok((manager.getSession(roomName)?.positionMs ?? 0) > (pausedPosition ?? 0));

  const tracksBeforeSkip = monitors.map(({ subscribedTracks }) => subscribedTracks);
  assert.match((await manager.execute(command('/skip'))).message, /Test Tone #2/);
  await waitForCondition(
    () => monitors.every((monitor, index) => monitor.subscribedTracks > (tracksBeforeSkip[index] ?? 0)),
    'track seguinte após skip',
  );
  assert.equal(manager.getSession(roomName)?.currentTrack?.title, 'Test Tone #2');
  assert.equal(manager.getSession(roomName)?.queue.length, 0);

  const tracksBeforeStop = monitors.map(({ unsubscribedTracks }) => unsubscribedTracks);
  await manager.execute(command('/stop'));
  await waitForCondition(
    () => monitors.every((monitor, index) => monitor.unsubscribedTracks > (tracksBeforeStop[index] ?? 0)),
    'unpublish após stop',
  );
  assert.equal(manager.getSession(roomName)?.state, 'STOPPED');
  assert.equal(manager.getSession(roomName)?.currentTrack, null);

  const tracksBeforeLocal = monitors.map(({ subscribedTracks }) => subscribedTracks);
  const framesBeforeLocal = monitors.map(({ nonSilentFrames }) => nonSilentFrames);
  assert.match((await manager.execute(command('/play-local'))).message, /FFmpeg Local Test/);
  assert.equal(manager.getSession(roomName)?.currentTrack?.source, 'LOCAL_FFMPEG_FILE');
  await waitForCondition(
    () => monitors.every((monitor, index) => monitor.subscribedTracks > (tracksBeforeLocal[index] ?? 0)),
    'track FFmpeg local',
  );
  await waitForCondition(
    () => monitors.every((monitor, index) => monitor.nonSilentFrames >= (framesBeforeLocal[index] ?? 0) + 5),
    'áudio FFmpeg nos dois clientes',
  );

  assert.match((await manager.execute(command('/pause'))).message, /pausada/i);
  const localPausedPosition = manager.getSession(roomName)?.positionMs ?? 0;
  await delay(250);
  assert.equal(manager.getSession(roomName)?.positionMs, localPausedPosition);
  assert.match((await manager.execute(command('/resume'))).message, /retomada/i);
  await waitForCondition(
    () => (manager.getSession(roomName)?.positionMs ?? 0) > localPausedPosition,
    'posição FFmpeg avançar após resume',
  );
  await manager.execute(command('/volume 25'));
  assert.equal(manager.getSession(roomName)?.volume, 25);

  await manager.execute(command('/play-file'));
  assert.equal(manager.getSession(roomName)?.queue.length, 1);
  const tracksBeforeLocalSkip = monitors.map(({ subscribedTracks }) => subscribedTracks);
  assert.match((await manager.execute(command('/skip'))).message, /Test Tone/);
  await waitForCondition(
    () => monitors.every((monitor, index) => monitor.subscribedTracks > (tracksBeforeLocalSkip[index] ?? 0)),
    'próxima track após skip do FFmpeg',
  );
  await manager.execute(command('/stop'));

  const tracksBeforeLocalLeave = monitors.map(({ subscribedTracks }) => subscribedTracks);
  await manager.execute(command('/play-local'));
  await waitForCondition(
    () => monitors.every((monitor, index) => monitor.subscribedTracks > (tracksBeforeLocalLeave[index] ?? 0)),
    'novo FFmpeg após stop',
  );
  assert.match((await manager.execute(command('/leave'))).message, /saiu do canal/);
  await waitForCondition(
    () => monitors.every(({ botDisconnected }) => botDisconnected),
    'disconnect do bot após leave',
  );
  assert.equal(manager.activeSessions, 0);

  console.log(
    `[INTEGRATION] PASS room=${roomName} clients=2 pause=ok resume=ok skip=ok stop=ok leave=ok`,
  );
} finally {
  await manager.shutdown();
  await Promise.all(subscribers.map((room) => room.disconnect().catch(() => {})));
  await Promise.allSettled(monitors.flatMap(({ streamTasks }) => streamTasks));
  dispose();
}
