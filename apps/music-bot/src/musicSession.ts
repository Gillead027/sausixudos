import { randomUUID } from 'node:crypto';
import type {
  AuthenticatedUserIdentity,
  MusicBotCommandRequest,
  MusicCommandResponse,
} from '@sausixudos/shared';
import type {
  MusicLog,
  MusicPlaybackHandle,
  MusicVoiceParticipant,
  VoiceLifecycleCallbacks,
} from './botVoiceParticipant.js';
import { TEST_AUDIO_DURATION_MS } from './programmaticAudioSource.js';

export type MusicSessionState =
  | 'IDLE'
  | 'CONNECTING'
  | 'PLAYING'
  | 'PAUSED'
  | 'STOPPED'
  | 'ERROR';

export interface MusicTrack {
  id: string;
  title: string;
  source: 'PROGRAMMATIC_TEST_TONE';
  durationMs: number;
  requestedBy: AuthenticatedUserIdentity;
  createdAt: number;
}

interface MusicSessionOptions {
  roomName: string;
  channelId: string;
  botParticipant: MusicVoiceParticipant;
  log: MusicLog;
  onDestroyed: () => void;
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function reply(message: string): MusicCommandResponse {
  return { message };
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

  private async playFileCommand(requester: AuthenticatedUserIdentity): Promise<MusicCommandResponse> {
    const track = this.createTrack(requester);
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
      ? reply(`SausiMusic começou a tocar ${track.title}.`)
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
      this.playback = await this.botParticipant.startTestAudio(this.volume, {
        onFinished: () => void this.finishPlayback(generation),
        onError: (error) => void this.failPlayback(generation, error),
      });
      this.state = 'PLAYING';
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
      ? reply(`Faixa pulada. Tocando agora: ${next.title}.`)
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
    return reply(`${now} ${queued}`);
  }

  private nowPlayingCommand(): MusicCommandResponse {
    if (!this.currentTrack) return reply('Nada tocando no momento.');
    return reply(
      `Tocando agora: ${this.currentTrack.title}. Solicitado por: ${this.currentTrack.requestedBy.displayName}. ` +
      `Estado: ${this.state}. Posição: ${formatTime(this.positionMs)} / ${formatTime(this.currentTrack.durationMs)}. ` +
      `Volume: ${this.volume}%.`,
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
  ) {}

  get activeSessions(): number {
    return this.sessions.size;
  }

  getSession(channelId: string): MusicSession | undefined {
    return this.sessions.get(channelId);
  }

  async execute(request: MusicBotCommandRequest): Promise<MusicCommandResponse> {
    this.log('command received', {
      room: request.channelId,
      channel: request.channelId,
      command: request.command,
      user: request.requestedBy.id,
    });
    let session = this.sessions.get(request.channelId);
    if (!session && request.command !== 'play-file') return this.noSessionResponse(request.command);

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
      });
      this.sessions.set(request.channelId, session);
    }

    return session.execute(request);
  }

  private noSessionResponse(command: MusicBotCommandRequest['command']): MusicCommandResponse {
    if (command === 'queue') return reply('Nada tocando no momento. Fila vazia.');
    if (command === 'nowplaying') return reply('Nada tocando no momento.');
    if (command === 'leave') return reply('SausiMusic não está neste canal.');
    return reply('Não há uma sessão musical ativa neste canal. Use /play-file primeiro.');
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
