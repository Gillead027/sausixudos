import { randomUUID } from 'node:crypto';
import type {
  AuthenticatedUserIdentity,
  MusicBotCommandRequest,
  MusicCommandResponse,
  MusicNowPlayingCard,
} from '@sausixudos/shared';
import type {
  MusicLog,
  MusicPlaybackHandle,
  MusicVoiceParticipant,
  VoiceLifecycleCallbacks,
} from './botVoiceParticipant.js';
import {
  DIAGNOSTIC_AUDIO_DURATION_MS,
  ensureDiagnosticAudioFile,
} from './ffmpegAudioSource.js';
import { TEST_AUDIO_DURATION_MS } from './programmaticAudioSource.js';
import type { MusicProviderRegistry, ResolvedMusicTrack } from './musicProvider.js';

export type MusicSessionState =
  | 'IDLE'
  | 'CONNECTING'
  | 'PLAYING'
  | 'PAUSED'
  | 'STOPPED'
  | 'ERROR';

interface MusicTrackBase {
  id: string;
  title: string;
  durationMs: number;
  requestedBy: AuthenticatedUserIdentity;
  createdAt: number;
}

export type MusicTrack = MusicTrackBase & (
  | { source: 'PROGRAMMATIC_TEST_TONE' }
  | { source: 'LOCAL_FFMPEG_FILE'; filePath: string }
  | { source: 'EXTERNAL_PROVIDER'; providerTrack: ResolvedMusicTrack }
);

interface MusicSessionOptions {
  roomName: string;
  channelId: string;
  botParticipant: MusicVoiceParticipant;
  log: MusicLog;
  onDestroyed: () => void;
  providers: MusicProviderRegistry;
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function reply(message: string, nowPlaying?: MusicNowPlayingCard): MusicCommandResponse {
  return nowPlaying ? { message, nowPlaying } : { message };
}

export class MusicSession {
  readonly id = randomUUID();
  readonly roomName: string;
  readonly channelId: string;
  readonly botParticipant: MusicVoiceParticipant;
  state: MusicSessionState = 'IDLE';
  currentTrack: MusicTrack | null = null;
  startedAt: number | null = null;
  volume = 100;

  private readonly upcomingTracks: MusicTrack[] = [];
  private readonly playedHistory: MusicTrack[] = [];
  private commandLock: Promise<void> = Promise.resolve();
  private playbackGeneration = 0;
  private playback: MusicPlaybackHandle | null = null;
  private trackSequence = 0;
  private destroyed = false;

  constructor(private readonly options: MusicSessionOptions) {
    this.roomName = options.roomName;
    this.channelId = options.channelId;
    this.botParticipant = options.botParticipant;
  }

  get queue(): readonly MusicTrack[] {
    return this.upcomingTracks;
  }

  get positionMs(): number {
    return this.currentTrack ? (this.playback?.positionMs ?? 0) : 0;
  }

  execute(request: MusicBotCommandRequest): Promise<MusicCommandResponse> {
    return this.exclusive(async () => {
      switch (request.command) {
        case 'play-file':
          return this.playFileCommand(request.requestedBy);
        case 'play-local':
          return this.playLocalCommand(request.requestedBy);
        case 'play':
          return this.playCommand(request.args.input, request.requestedBy);
        case 'playlist':
          return this.playlistCommand(request.args.input, request.requestedBy);
        case 'history':
          return this.historyCommand();
        case 'pause':
          return this.pauseCommand();
        case 'resume':
          return this.resumeCommand();
        case 'skip':
          return this.skipCommand();
        case 'stop':
          return this.stopCommand();
        case 'leave':
          return this.leaveCommand();
        case 'queue':
          return this.queueCommand();
        case 'nowplaying':
          return this.nowPlayingCommand();
        case 'volume':
          return this.volumeCommand(request.args.volume);
        case 'clear':
          return this.clearCommand();
      }
    });
  }

  dispose(reason: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.destroyed) return;
      this.destroyed = true;
      this.playbackGeneration += 1;
      this.upcomingTracks.length = 0;
      await this.botParticipant.stopAudio();
      await this.botParticipant.disconnect();
      this.playback = null;
      this.currentTrack = null;
      this.startedAt = null;
      this.state = 'STOPPED';
      this.options.log('session cleaned', {
        room: this.roomName,
        channel: this.channelId,
        session: this.id,
        reason,
      });
      this.options.onDestroyed();
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.commandLock.then(operation, operation);
    this.commandLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private createTrack(requester: AuthenticatedUserIdentity): MusicTrack {
    this.trackSequence += 1;
    return {
      id: randomUUID(),
      title: `Test Tone #${this.trackSequence}`,
      source: 'PROGRAMMATIC_TEST_TONE',
      durationMs: TEST_AUDIO_DURATION_MS,
      requestedBy: { ...requester },
      createdAt: Date.now(),
    };
  }

  private createLocalTrack(requester: AuthenticatedUserIdentity): MusicTrack {
    this.trackSequence += 1;
    return {
      id: randomUUID(),
      title: `FFmpeg Local Test #${this.trackSequence}`,
      source: 'LOCAL_FFMPEG_FILE',
      filePath: ensureDiagnosticAudioFile(),
      durationMs: DIAGNOSTIC_AUDIO_DURATION_MS,
      requestedBy: { ...requester },
      createdAt: Date.now(),
    };
  }

  private playFileCommand(requester: AuthenticatedUserIdentity): Promise<MusicCommandResponse> {
    return this.enqueueOrStart(this.createTrack(requester));
  }

  private playLocalCommand(requester: AuthenticatedUserIdentity): Promise<MusicCommandResponse> {
    return this.enqueueOrStart(this.createLocalTrack(requester));
  }

  private async playCommand(input: string, requester: AuthenticatedUserIdentity): Promise<MusicCommandResponse> {
    this.options.log('search requested', { room: this.roomName, session: this.id, inputLength: input.length });
    try {
      const resolved = await this.options.providers.resolveInput(input);
      const track = this.externalTrack(resolved, requester);
      this.options.log('provider resolved', { room: this.roomName, session: this.id, provider: resolved.providerId, track: resolved.sourceId });
      return this.enqueueOrStart(track);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log('provider resolve failed', { room: this.roomName, session: this.id, error: message });
      return reply(`Não consegui encontrar ou resolver essa música: ${message}`);
    }
  }

  private externalTrack(resolved: ResolvedMusicTrack, requester: AuthenticatedUserIdentity): MusicTrack {
    return {
      id: randomUUID(),
      title: resolved.title,
      source: 'EXTERNAL_PROVIDER',
      providerTrack: resolved,
      durationMs: resolved.durationMs,
      requestedBy: { ...requester },
      createdAt: Date.now(),
    };
  }

  private async playlistCommand(input: string, requester: AuthenticatedUserIdentity): Promise<MusicCommandResponse> {
    try {
      const resolvedTracks = await this.options.providers.resolvePlaylistInput(input);
      const tracks = resolvedTracks.map((resolved) => this.externalTrack(resolved, requester));
      if (tracks.length === 0) return reply('A playlist não possui faixas reproduzíveis.');
      if (this.currentTrack) {
        this.upcomingTracks.push(...tracks);
        return reply(`Playlist adicionada à fila: ${tracks.length} faixa(s).`);
      }
      const first = tracks.shift()!;
      this.upcomingTracks.push(...tracks);
      const started = await this.startTrack(first);
      if (!started) {
        this.upcomingTracks.length = 0;
        return reply(`Não foi possível iniciar a playlist por ${first.title}.`);
      }
      return reply(`Playlist iniciada com ${resolvedTracks.length} faixa(s). Tocando: ${first.title}.`, this.nowPlayingCard());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply(`Não consegui carregar essa playlist: ${message}`);
    }
  }

  private historyCommand(): MusicCommandResponse {
    if (this.playedHistory.length === 0) return reply('O histórico de reprodução está vazio.');
    const items = this.playedHistory.slice(-10).reverse();
    return reply(`Histórico: ${items.map((track, index) => `${index + 1}. ${track.title}`).join('; ')}.`, this.nowPlayingCard());
  }

  private async enqueueOrStart(track: MusicTrack): Promise<MusicCommandResponse> {
    if (this.currentTrack) {
      this.upcomingTracks.push(track);
      this.options.log('track queued', {
        room: this.roomName,
        session: this.id,
        track: track.id,
        position: this.upcomingTracks.length,
      });
      return reply(`Adicionado à fila: ${track.title}. Posição: ${this.upcomingTracks.length}.`);
    }

    const started = await this.startTrack(track);
    return started
      ? reply(`SausiMusic começou a tocar ${track.title}.`, this.nowPlayingCard())
      : reply(`Não foi possível tocar ${track.title}.`);
  }

  private async startTrack(track: MusicTrack): Promise<boolean> {
    if (this.destroyed) return false;
    this.state = 'CONNECTING';
    this.currentTrack = track;
    this.startedAt = Date.now();
    const generation = ++this.playbackGeneration;

    try {
      await this.botParticipant.connect();
      const callbacks = {
        onFinished: () => void this.finishPlayback(generation),
        onError: (error: Error) => void this.failPlayback(generation, error),
      };
      if (track.source === 'LOCAL_FFMPEG_FILE') {
        this.playback = await this.botParticipant.startLocalFileAudio(track.filePath, this.volume, callbacks);
      } else if (track.source === 'EXTERNAL_PROVIDER') {
        this.options.log('resolving playable source', { room: this.roomName, session: this.id, provider: track.providerTrack.providerId, track: track.providerTrack.sourceId });
        const playable = await this.options.providers.resolvePlayable(track.providerTrack);
        this.playback = await this.botParticipant.startExternalAudio(playable, this.volume, callbacks);
        this.options.log('external playback started', { room: this.roomName, session: this.id, provider: playable.providerId, track: track.providerTrack.sourceId });
      } else {
        this.playback = await this.botParticipant.startTestAudio(this.volume, callbacks);
      }
      this.state = 'PLAYING';
      this.playedHistory.push(track);
      if (this.playedHistory.length > 20) this.playedHistory.splice(0, this.playedHistory.length - 20);
      this.options.log('playback started', {
        room: this.roomName,
        channel: this.channelId,
        session: this.id,
        track: track.id,
      });
      return true;
    } catch (error) {
      await this.failCurrentTrack(generation, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private finishPlayback(generation: number): Promise<void> {
    return this.exclusive(async () => {
      if (this.destroyed || generation !== this.playbackGeneration) return;
      const finishedTrack = this.currentTrack;
      this.playback = null;
      this.currentTrack = null;
      this.startedAt = null;
      this.options.log('playback finished', {
        room: this.roomName,
        session: this.id,
        track: finishedTrack?.id ?? 'unknown',
      });
      await this.advanceQueue('NATURAL_END');
    });
  }

  private failPlayback(generation: number, error: Error): Promise<void> {
    return this.exclusive(() => this.failCurrentTrack(generation, error));
  }

  private async failCurrentTrack(generation: number, error: Error): Promise<void> {
    if (this.destroyed || generation !== this.playbackGeneration) return;
    this.playbackGeneration += 1;
    await this.botParticipant.stopAudio().catch(() => {});
    this.playback = null;
    this.currentTrack = null;
    this.startedAt = null;
    this.upcomingTracks.length = 0;
    this.state = 'ERROR';
    this.options.log('playback error', {
      room: this.roomName,
      channel: this.channelId,
      session: this.id,
      error: error.message,
    });
  }

  private async advanceQueue(reason: 'NATURAL_END' | 'SKIPPED'): Promise<MusicTrack | null> {
    const next = this.upcomingTracks.shift() ?? null;
    if (!next) {
      this.state = 'IDLE';
      this.options.log('session idle', {
        room: this.roomName,
        session: this.id,
        reason,
      });
      return null;
    }
    this.options.log('advancing queue', {
      room: this.roomName,
      session: this.id,
      reason,
      track: next.id,
      remaining: this.upcomingTracks.length,
    });
    return (await this.startTrack(next)) ? next : null;
  }

  private nowPlayingCard(): MusicNowPlayingCard | undefined {
    const track = this.currentTrack;
    if (!track) return undefined;
    if (track.source === 'EXTERNAL_PROVIDER') {
      const card: MusicNowPlayingCard = {
        title: track.title,
        author: track.providerTrack.author,
        providerId: track.providerTrack.providerId,
        durationMs: track.durationMs,
        positionMs: this.positionMs,
        requestedBy: track.requestedBy.displayName,
        state: this.state,
        volume: this.volume,
        queueSize: this.upcomingTracks.length,
      };
      if (track.providerTrack.thumbnailUrl) card.thumbnailUrl = track.providerTrack.thumbnailUrl;
      if (track.providerTrack.webUrl) card.webUrl = track.providerTrack.webUrl;
      return card;
    }
    return {
      title: track.title,
      author: 'SausiMusic',
      providerId: track.source === 'LOCAL_FFMPEG_FILE' ? 'local' : 'diagnostic',
      durationMs: track.durationMs,
      positionMs: this.positionMs,
      requestedBy: track.requestedBy.displayName,
      state: this.state,
      volume: this.volume,
      queueSize: this.upcomingTracks.length,
    };
  }

  private pauseCommand(): MusicCommandResponse {
    if (this.state !== 'PLAYING' || !this.currentTrack || !this.playback) {
      return reply('Não há reprodução ativa para pausar.');
    }
    this.playback.pause();
    this.state = 'PAUSED';
    this.options.log('playback paused', {
      room: this.roomName,
      session: this.id,
      track: this.currentTrack.id,
      positionMs: this.positionMs,
    });
    return reply('Reprodução pausada.');
  }

  private resumeCommand(): MusicCommandResponse {
    if (this.state !== 'PAUSED' || !this.currentTrack || !this.playback) {
      return reply('Não há reprodução pausada para retomar.');
    }
    this.playback.resume();
    this.state = 'PLAYING';
    this.options.log('playback resumed', {
      room: this.roomName,
      session: this.id,
      track: this.currentTrack.id,
      positionMs: this.positionMs,
    });
    return reply('Reprodução retomada.');
  }

  private async skipCommand(): Promise<MusicCommandResponse> {
    if (!this.currentTrack) return reply('Não há faixa para pular.');
    const skipped = this.currentTrack;
    this.playbackGeneration += 1;
    await this.botParticipant.stopAudio();
    this.playback = null;
    this.currentTrack = null;
    this.startedAt = null;
    this.options.log('playback skipped', {
      room: this.roomName,
      session: this.id,
      track: skipped.id,
    });
    const next = await this.advanceQueue('SKIPPED');
    return next
      ? reply(`Faixa pulada. Tocando agora: ${next.title}.`, this.nowPlayingCard())
      : reply('Faixa pulada. A fila terminou.');
  }

  private async stopCommand(): Promise<MusicCommandResponse> {
    const hadPlayback = Boolean(this.currentTrack);
    const cleared = this.upcomingTracks.length;
    this.playbackGeneration += 1;
    this.upcomingTracks.length = 0;
    await this.botParticipant.stopAudio();
    this.playback = null;
    this.currentTrack = null;
    this.startedAt = null;
    this.state = 'STOPPED';
    this.options.log('playback stopped', {
      room: this.roomName,
      session: this.id,
      cleared,
    });
    return reply(hadPlayback || cleared > 0 ? 'Reprodução parada e fila limpa.' : 'Nada estava tocando.');
  }

  private async leaveCommand(): Promise<MusicCommandResponse> {
    this.destroyed = true;
    this.playbackGeneration += 1;
    this.upcomingTracks.length = 0;
    await this.botParticipant.stopAudio();
    this.playback = null;
    this.currentTrack = null;
    this.startedAt = null;
    this.state = 'STOPPED';
    await this.botParticipant.disconnect();
    this.options.log('session left', {
      room: this.roomName,
      session: this.id,
    });
    this.options.onDestroyed();
    return reply('SausiMusic saiu do canal de voz.');
  }

  private volumeCommand(volume: number): MusicCommandResponse {
    this.volume = volume;
    this.playback?.setVolume(volume);
    this.options.log('volume changed', {
      room: this.roomName,
      session: this.id,
      volume,
    });
    return reply(`Volume do SausiMusic ajustado para ${volume}%.`);
  }

  private clearCommand(): MusicCommandResponse {
    const cleared = this.upcomingTracks.length;
    this.upcomingTracks.length = 0;
    this.options.log('queue cleared', {
      room: this.roomName,
      session: this.id,
      cleared,
    });
    return reply(cleared > 0 ? `Fila limpa. ${cleared} faixa(s) removida(s).` : 'A fila já está vazia.');
  }

  private queueCommand(): MusicCommandResponse {
    const now = this.currentTrack
      ? `Tocando agora: ${this.currentTrack.title} — ${formatTime(this.positionMs)} / ${formatTime(this.currentTrack.durationMs)}.`
      : 'Nada tocando no momento.';
    const queued = this.upcomingTracks.length > 0
      ? `Fila: ${this.upcomingTracks.map((track, index) => `${index + 1}. ${track.title}`).join('; ')}.`
      : 'Fila vazia.';
    return reply(`${now} ${queued}`, this.nowPlayingCard());
  }

  private nowPlayingCommand(): MusicCommandResponse {
    if (!this.currentTrack) return reply('Nada tocando no momento.');
    return reply(
      `Tocando agora: ${this.currentTrack.title}. Solicitado por: ${this.currentTrack.requestedBy.displayName}. ` +
      `Estado: ${this.state}. Posição: ${formatTime(this.positionMs)} / ${formatTime(this.currentTrack.durationMs)}. ` +
      `Volume: ${this.volume}%.`,
      this.nowPlayingCard(),
    );
  }
}

export interface MusicSessionContext {
  roomName: string;
  channelId: string;
}

export type MusicVoiceParticipantFactory = (
  context: MusicSessionContext,
  lifecycle: VoiceLifecycleCallbacks,
) => MusicVoiceParticipant;

export class MusicSessionManager {
  private readonly sessions = new Map<string, MusicSession>();

  constructor(
    private readonly createParticipant: MusicVoiceParticipantFactory,
    private readonly log: MusicLog,
    private readonly providers: MusicProviderRegistry,
    private readonly djUserIds: ReadonlySet<string> = new Set<string>(),
  ) {}

  get activeSessions(): number {
    return this.sessions.size;
  }

  getSession(channelId: string): MusicSession | undefined {
    return this.sessions.get(channelId);
  }

  async execute(request: MusicBotCommandRequest): Promise<MusicCommandResponse> {
    const djCommands = new Set<MusicBotCommandRequest['command']>(['pause', 'resume', 'skip', 'stop', 'leave', 'volume', 'clear']);
    if (this.djUserIds.size > 0 && djCommands.has(request.command) && !this.djUserIds.has(request.requestedBy.id)) {
      return reply('Este comando é restrito aos DJs configurados do SausiMusic.');
    }
    this.log('command received', {
      room: request.channelId,
      channel: request.channelId,
      command: request.command,
      user: request.requestedBy.id,
    });
    let session = this.sessions.get(request.channelId);
    if (!session && request.command !== 'play-file' && request.command !== 'play-local' && request.command !== 'play' && request.command !== 'playlist') {
      return this.noSessionResponse(request.command);
    }

    if (!session) {
      const context = { roomName: request.channelId, channelId: request.channelId };
      const participant = this.createParticipant(context, {
        onHumansEmpty: () => void this.cleanup(request.channelId, 'last-human-left'),
        onDisconnected: () => void this.cleanup(request.channelId, 'voice-disconnected'),
      });
      session = new MusicSession({
        ...context,
        botParticipant: participant,
        log: this.log,
        onDestroyed: () => {
          if (this.sessions.get(request.channelId) === session) this.sessions.delete(request.channelId);
        },
        providers: this.providers,
      });
      this.sessions.set(request.channelId, session);
    }

    return session.execute(request);
  }

  private noSessionResponse(command: MusicBotCommandRequest['command']): MusicCommandResponse {
    if (command === 'queue') return reply('Nada tocando no momento. Fila vazia.');
    if (command === 'nowplaying') return reply('Nada tocando no momento.');
    if (command === 'history') return reply('O histórico de reprodução está vazio.');
    if (command === 'leave') return reply('SausiMusic não está neste canal.');
    return reply('Não há uma sessão musical ativa neste canal. Use /play <música> primeiro.');
  }

  async cleanup(channelId: string, reason: string): Promise<void> {
    const session = this.sessions.get(channelId);
    if (session) await session.dispose(reason);
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.values()).map((session) => session.dispose('worker-shutdown')),
    );
  }
}
