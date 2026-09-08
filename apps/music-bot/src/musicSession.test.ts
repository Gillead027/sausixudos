import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMusicCommand, type MusicBotCommandRequest } from '@sausixudos/shared';
import type {
  MusicPlaybackHandle,
  MusicVoiceParticipant,
  PlaybackCallbacks,
  VoiceLifecycleCallbacks,
} from './botVoiceParticipant.js';
import { MusicSessionManager } from './musicSession.js';
import { MusicProviderRegistry, type MusicProvider, type PlayableMusicSource } from './musicProvider.js';

const requester = { id: 'user-1', displayName: 'Gillezin' };

const fakeProvider: MusicProvider = {
  id: 'youtube',
  canHandleUrl: () => true,
  search: async (query) => [{ providerId: 'youtube', sourceId: 'fake-id', title: query, author: 'Fake Artist', durationMs: 180000, webUrl: 'https://youtube.com/watch?v=fake', thumbnailUrl: undefined }],
  resolveUrl: async () => ({ providerId: 'youtube', sourceId: 'fake-id', title: 'URL Track', author: 'Fake Artist', durationMs: 180000, webUrl: 'https://youtube.com/watch?v=fake', thumbnailUrl: undefined }),
  resolvePlayable: async () => ({ input: 'https://youtube.com/watch?v=fake', providerId: 'youtube', transport: 'YTDLP_PIPE' }),
  resolvePlaylist: async () => [
    { providerId: 'youtube', sourceId: 'p1', title: 'Playlist One', author: 'Artist 1', durationMs: 120000, webUrl: 'https://youtube.com/watch?v=p1', thumbnailUrl: undefined },
    { providerId: 'youtube', sourceId: 'p2', title: 'Playlist Two', author: 'Artist 2', durationMs: 130000, webUrl: 'https://youtube.com/watch?v=p2', thumbnailUrl: undefined },
  ],
};
const fakeProviders = new MusicProviderRegistry([fakeProvider], 'youtube');

function command(text: string, channelId = 'geral'): MusicBotCommandRequest {
  const parsed = parseMusicCommand(text);
  assert.ok(parsed, `Comando inválido no teste: ${text}`);
  return {
    channelId,
    command: parsed.name,
    args: parsed.args,
    requestedBy: requester,
  } as MusicBotCommandRequest;
}

class FakePlayback implements MusicPlaybackHandle {
  positionMs = 0;
  paused = false;
  volume: number;

  constructor(initialVolume: number) {
    this.volume = initialVolume;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  setVolume(volume: number): void {
    this.volume = volume;
  }
}

class FakeVoiceParticipant implements MusicVoiceParticipant {
  connected = false;
  connectCalls = 0;
  startCalls = 0;
  localStartCalls = 0;
  externalStartCalls = 0;
  stopCalls = 0;
  disconnectCalls = 0;
  activePlaybacks = 0;
  maxActivePlaybacks = 0;
  playbackCallbacks: PlaybackCallbacks | null = null;
  playback: FakePlayback | null = null;

  constructor(private readonly startError?: Error) {}

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.connected = true;
  }

  async startTestAudio(
    initialVolume: number,
    callbacks: PlaybackCallbacks,
  ): Promise<MusicPlaybackHandle> {
    this.startCalls += 1;
    if (this.startError) throw this.startError;
    this.activePlaybacks += 1;
    this.maxActivePlaybacks = Math.max(this.maxActivePlaybacks, this.activePlaybacks);
    this.playbackCallbacks = callbacks;
    this.playback = new FakePlayback(initialVolume);
    return this.playback;
  }

  async startLocalFileAudio(
    _filePath: string,
    initialVolume: number,
    callbacks: PlaybackCallbacks,
  ): Promise<MusicPlaybackHandle> {
    this.localStartCalls += 1;
    if (this.startError) throw this.startError;
    this.activePlaybacks += 1;
    this.maxActivePlaybacks = Math.max(this.maxActivePlaybacks, this.activePlaybacks);
    this.playbackCallbacks = callbacks;
    this.playback = new FakePlayback(initialVolume);
    return this.playback;
  }

  async startExternalAudio(
    _playable: PlayableMusicSource,
    initialVolume: number,
    callbacks: PlaybackCallbacks,
  ): Promise<MusicPlaybackHandle> {
    this.externalStartCalls += 1;
    return this.startTestAudio(initialVolume, callbacks);
  }

  finishNaturally(): void {
    const callbacks = this.playbackCallbacks;
    assert.ok(callbacks);
    this.playbackCallbacks = null;
    this.playback = null;
    this.activePlaybacks -= 1;
    callbacks.onFinished();
  }

  async stopAudio(): Promise<void> {
    this.stopCalls += 1;
    if (this.playbackCallbacks) this.activePlaybacks -= 1;
    this.playbackCallbacks = null;
    this.playback = null;
  }

  async sendMessage(): Promise<void> {}

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.connected = false;
  }
}

function createHarness(startError?: Error, djUserIds: ReadonlySet<string> = new Set<string>()) {
  const participants: FakeVoiceParticipant[] = [];
  const lifecycles = new Map<string, VoiceLifecycleCallbacks>();
  const manager = new MusicSessionManager((context, callbacks) => {
    lifecycles.set(context.channelId, callbacks);
    const participant = new FakeVoiceParticipant(startError);
    participants.push(participant);
    return participant;
  }, () => {}, fakeProviders, djUserIds);
  return { manager, participants, lifecycles };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('MusicSession player stateful', () => {
  it('executa fila FIFO A -> B -> C com auto-next e termina IDLE', async () => {
    const harness = createHarness();
    await harness.manager.execute(command('/play-file'));
    await harness.manager.execute(command('/play-file'));
    await harness.manager.execute(command('/play-file'));

    const session = harness.manager.getSession('geral');
    const participant = harness.participants[0];
    assert.ok(session && participant);
    const [queuedB, queuedC] = session.queue;
    const trackA = session.currentTrack;
    assert.ok(trackA && queuedB && queuedC);
    assert.equal(trackA.title, 'Test Tone #1');
    assert.equal(queuedB.title, 'Test Tone #2');
    assert.equal(queuedC.title, 'Test Tone #3');
    assert.equal(new Set([trackA.id, queuedB.id, queuedC.id]).size, 3);

    participant.finishNaturally();
    await nextTurn();
    assert.equal(session.currentTrack?.id, queuedB.id);
    assert.deepEqual(session.queue.map(({ id }) => id), [queuedC.id]);

    participant.finishNaturally();
    await nextTurn();
    assert.equal(session.currentTrack?.id, queuedC.id);
    assert.equal(session.queue.length, 0);

    participant.finishNaturally();
    await nextTurn();
    assert.equal(session.state, 'IDLE');
    assert.equal(session.currentTrack, null);
    assert.equal(participant.startCalls, 3);
    assert.equal(participant.maxActivePlaybacks, 1);
  });

  it('faz PLAYING -> PAUSED -> PLAYING sem perder faixa ou posição', async () => {
    const harness = createHarness();
    await harness.manager.execute(command('/play-file'));
    const session = harness.manager.getSession('geral');
    const participant = harness.participants[0];
    assert.ok(session && participant?.playback);
    const trackId = session.currentTrack?.id;
    participant.playback.positionMs = 1_240;

    assert.match((await harness.manager.execute(command('/pause'))).message, /pausada/i);
    assert.equal(session.state, 'PAUSED');
    assert.equal(session.positionMs, 1_240);
    assert.equal(participant.playback.paused, true);

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(session.positionMs, 1_240);
    assert.match((await harness.manager.execute(command('/resume'))).message, /retomada/i);
    assert.equal(session.state, 'PLAYING');
    assert.equal(session.currentTrack?.id, trackId);
    assert.equal(session.positionMs, 1_240);
    assert.equal(participant.playback.paused, false);
    assert.equal(participant.startCalls, 1);
  });

  it('skip funciona em PAUSED e inicia a próxima faixa', async () => {
    const harness = createHarness();
    await harness.manager.execute(command('/play-file'));
    await harness.manager.execute(command('/play-file'));
    const session = harness.manager.getSession('geral');
    assert.ok(session);
    const nextId = session.queue[0]?.id;
    await harness.manager.execute(command('/pause'));

    const result = await harness.manager.execute(command('/skip'));
    assert.match(result.message, /Tocando agora: Test Tone #2/);
    assert.equal(result.nowPlaying?.title, 'Test Tone #2');
    assert.equal(result.nowPlaying?.queueSize, 0);
    assert.equal(session.state, 'PLAYING');
    assert.equal(session.currentTrack?.id, nextId);
    assert.equal(session.queue.length, 0);
  });

  it('stop interrompe, limpa a fila, preserva conexão e permite novo play', async () => {
    const harness = createHarness();
    await harness.manager.execute(command('/play-file'));
    await harness.manager.execute(command('/play-file'));
    await harness.manager.execute(command('/stop'));

    const session = harness.manager.getSession('geral');
    const participant = harness.participants[0];
    assert.ok(session && participant);
    assert.equal(session.state, 'STOPPED');
    assert.equal(session.currentTrack, null);
    assert.equal(session.queue.length, 0);
    assert.equal(participant.connected, true);
    assert.equal(harness.manager.activeSessions, 1);

    await harness.manager.execute(command('/play-file'));
    const replayedSession = harness.manager.getSession('geral');
    assert.equal(replayedSession?.state, 'PLAYING');
    assert.equal(replayedSession?.currentTrack?.title, 'Test Tone #3');
    assert.equal(participant.startCalls, 2);
  });

  it('clear remove somente faixas futuras', async () => {
    const harness = createHarness();
    await harness.manager.execute(command('/play-file'));
    await harness.manager.execute(command('/play-file'));
    await harness.manager.execute(command('/play-file'));
    const session = harness.manager.getSession('geral');
    assert.ok(session);
    const currentId = session.currentTrack?.id;

    await harness.manager.execute(command('/clear'));
    assert.equal(session.currentTrack?.id, currentId);
    assert.equal(session.state, 'PLAYING');
    assert.equal(session.queue.length, 0);
  });

  it('queue e nowplaying incluem posição, estado, solicitante e volume', async () => {
    const harness = createHarness();
    await harness.manager.execute(command('/play-file'));
    await harness.manager.execute(command('/play-file'));
    const participant = harness.participants[0];
    assert.ok(participant?.playback);
    participant.playback.positionMs = 3_100;
    await harness.manager.execute(command('/volume 50'));

    const queue = await harness.manager.execute(command('/queue'));
    assert.match(queue.message, /Test Tone #1 — 00:03 \/ 00:06/);
    assert.match(queue.message, /1\. Test Tone #2/);
    const nowPlaying = await harness.manager.execute(command('/np'));
    assert.match(nowPlaying.message, /Gillezin/);
    assert.match(nowPlaying.message, /Estado: PLAYING/);
    assert.match(nowPlaying.message, /Volume: 50%/);
  });

  it('volume 0, 25, 50 e 100 altera imediatamente o playback atual', async () => {
    const harness = createHarness();
    await harness.manager.execute(command('/play-file'));
    const session = harness.manager.getSession('geral');
    const participant = harness.participants[0];
    assert.ok(session && participant?.playback);

    for (const volume of [0, 25, 50, 100]) {
      await harness.manager.execute(command(`/volume ${volume}`));
      assert.equal(session.volume, volume);
      assert.equal(participant.playback.volume, volume);
    }
  });

  it('leave durante playback limpa e remove a sessão', async () => {
    const harness = createHarness();
    await harness.manager.execute(command('/play-file'));
    await harness.manager.execute(command('/play-file'));
    const participant = harness.participants[0];
    assert.ok(participant);
    const staleFinish = participant.playbackCallbacks?.onFinished;

    const leaving = harness.manager.execute(command('/leave'));
    staleFinish?.();
    await leaving;
    await nextTurn();
    assert.equal(participant.disconnectCalls, 1);
    assert.equal(participant.activePlaybacks, 0);
    assert.equal(harness.manager.activeSessions, 0);
  });

  it('serializa natural-end + skip sem publicar duas tracks', async () => {
    const harness = createHarness();
    await harness.manager.execute(command('/play-file'));
    await harness.manager.execute(command('/play-file'));
    await harness.manager.execute(command('/play-file'));
    const participant = harness.participants[0];
    assert.ok(participant);

    participant.finishNaturally();
    await harness.manager.execute(command('/skip'));
    await nextTurn();
    const session = harness.manager.getSession('geral');
    assert.equal(session?.currentTrack?.title, 'Test Tone #3');
    assert.equal(session?.queue.length, 0);
    assert.equal(participant.maxActivePlaybacks, 1);
  });

  it('stop invalida callback natural concorrente e não executa auto-next', async () => {
    const harness = createHarness();
    await harness.manager.execute(command('/play-file'));
    await harness.manager.execute(command('/play-file'));
    const participant = harness.participants[0];
    assert.ok(participant);
    const staleFinish = participant.playbackCallbacks?.onFinished;

    const stopping = harness.manager.execute(command('/stop'));
    staleFinish?.();
    await stopping;
    await nextTurn();
    const session = harness.manager.getSession('geral');
    assert.equal(session?.state, 'STOPPED');
    assert.equal(session?.currentTrack, null);
    assert.equal(session?.queue.length, 0);
    assert.equal(participant.startCalls, 1);
  });

  it('pause seguido imediatamente de resume mantém um único playback', async () => {
    const harness = createHarness();
    await harness.manager.execute(command('/play-file'));
    await Promise.all([
      harness.manager.execute(command('/pause')),
      harness.manager.execute(command('/resume')),
    ]);
    const participant = harness.participants[0];
    assert.equal(harness.manager.getSession('geral')?.state, 'PLAYING');
    assert.equal(participant?.startCalls, 1);
    assert.equal(participant?.maxActivePlaybacks, 1);
  });

  it('dois play-file simultâneos criam uma faixa atual e uma enfileirada', async () => {
    const harness = createHarness();
    await Promise.all([
      harness.manager.execute(command('/play-file')),
      harness.manager.execute(command('/play-file')),
    ]);
    const session = harness.manager.getSession('geral');
    assert.equal(harness.participants.length, 1);
    assert.equal(session?.currentTrack?.title, 'Test Tone #1');
    assert.equal(session?.queue[0]?.title, 'Test Tone #2');
    assert.equal(harness.participants[0]?.maxActivePlaybacks, 1);
  });

  it('mantém filas independentes por room', async () => {
    const harness = createHarness();
    await harness.manager.execute(command('/play-file', 'geral'));
    await harness.manager.execute(command('/play-file', 'geral'));
    await harness.manager.execute(command('/play-file', 'jogos'));
    assert.equal(harness.manager.getSession('geral')?.queue.length, 1);
    assert.equal(harness.manager.getSession('jogos')?.queue.length, 0);
    assert.equal(harness.manager.activeSessions, 2);
  });

  it('limpa sessão quando o último humano sai', async () => {
    const harness = createHarness();
    await harness.manager.execute(command('/play-file'));
    harness.lifecycles.get('geral')?.onHumansEmpty();
    await nextTurn();
    assert.equal(harness.manager.activeSessions, 0);
    assert.equal(harness.participants[0]?.disconnectCalls, 1);
  });

  it('entra em ERROR e limpa recursos quando publicação falha', async () => {
    const harness = createHarness(new Error('publish failed'));
    const result = await harness.manager.execute(command('/play-file'));
    assert.match(result.message, /Não foi possível/);
    const session = harness.manager.getSession('geral');
    assert.equal(session?.state, 'ERROR');
    assert.equal(session?.currentTrack, null);
    assert.equal(session?.queue.length, 0);
  });

  it('play-local usa a fonte FFmpeg sem alterar o fluxo da sessão', async () => {
    const harness = createHarness();
    const result = await harness.manager.execute(command('/play-local'));
    const session = harness.manager.getSession('geral');
    const participant = harness.participants[0];
    assert.ok(session && participant);
    assert.match(result.message, /FFmpeg Local Test/);
    assert.equal(session.currentTrack?.source, 'LOCAL_FFMPEG_FILE');
    assert.equal(participant.localStartCalls, 1);
    assert.equal(participant.startCalls, 0);
    assert.equal(session.state, 'PLAYING');

    await harness.manager.execute(command('/volume 25'));
    assert.equal(participant.playback?.volume, 25);
    await harness.manager.execute(command('/stop'));
    assert.equal(session.state, 'STOPPED');
  });

  it('/playlist inicia primeira faixa e enfileira as demais', async () => {
    const harness = createHarness();
    const result = await harness.manager.execute(command('/playlist https://www.youtube.com/playlist?list=PL123'));
    const session = harness.manager.getSession('geral');
    assert.ok(session);
    assert.match(result.message, /Playlist iniciada com 2 faixa/);
    assert.equal(session.currentTrack?.title, 'Playlist One');
    assert.equal(session.queue[0]?.title, 'Playlist Two');
    assert.equal(result.nowPlaying?.title, 'Playlist One');
  });

  it('/history lista faixas já iniciadas em ordem recente', async () => {
    const harness = createHarness();
    await harness.manager.execute(command('/play-file'));
    await harness.manager.execute(command('/play-file'));
    const participant = harness.participants[0];
    assert.ok(participant);
    participant.finishNaturally();
    await nextTurn();
    const history = await harness.manager.execute(command('/history'));
    assert.match(history.message, /Test Tone #2/);
    assert.match(history.message, /Test Tone #1/);
  });

  it('restringe controles a DJs quando MUSIC_DJ_USER_IDS está configurado', async () => {
    const harness = createHarness(undefined, new Set(['dj-user']));
    await harness.manager.execute(command('/play-file'));
    const denied = await harness.manager.execute(command('/skip'));
    assert.match(denied.message, /restrito aos DJs/i);
    assert.equal(harness.manager.getSession('geral')?.currentTrack?.title, 'Test Tone #1');
    const djRequest = command('/stop');
    djRequest.requestedBy = { id: 'dj-user', displayName: 'DJ' };
    const allowed = await harness.manager.execute(djRequest);
    assert.match(allowed.message, /parada/i);
  });

  it('/play resolve metadata e inicia fonte externa somente no playback', async () => {
    const harness = createHarness();
    const result = await harness.manager.execute(command('/play Numb Linkin Park'));
    const session = harness.manager.getSession('geral');
    const participant = harness.participants[0];
    assert.ok(session && participant);
    assert.match(result.message, /Numb Linkin Park/);
    assert.equal(session.currentTrack?.source, 'EXTERNAL_PROVIDER');
    assert.equal(participant.externalStartCalls, 1);
    assert.equal(session.currentTrack?.durationMs, 180_000);
    const now = await harness.manager.execute(command('/np'));
    assert.match(now.message, /Numb Linkin Park/);
    await harness.manager.execute(command('/stop'));
  });


});
