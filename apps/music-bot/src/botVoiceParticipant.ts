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
import {
  CHAT_MESSAGE_MAX_LENGTH,
  MUSIC_BOT_DISPLAY_NAME,
  MUSIC_BOT_IDENTITY,
  MUSIC_BOT_TRACK_NAME,
  VOICE_CHAT_TOPIC,
  parseParticipantMetadata,
  type BotParticipantMetadata,
  type ChatMessage,
} from '@sausixudos/shared';
import {
  ProgrammaticAudioSource,
  TEST_AUDIO_CHANNELS,
  TEST_AUDIO_SAMPLE_RATE,
} from './programmaticAudioSource.js';

export type MusicLog = (event: string, context: Record<string, string | number>) => void;

export interface PlaybackCallbacks {
  onFinished: () => void;
  onError: (error: Error) => void;
}

export interface MusicPlaybackHandle {
  readonly positionMs: number;
  pause: () => void;
  resume: () => void;
  setVolume: (volume: number) => void;
}

export interface MusicVoiceParticipant {
  readonly connected: boolean;
  connect: () => Promise<void>;
  startTestAudio: (
    initialVolume: number,
    callbacks: PlaybackCallbacks,
  ) => Promise<MusicPlaybackHandle>;
  stopAudio: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  disconnect: () => Promise<void>;
}

export interface VoiceLifecycleCallbacks {
  onHumansEmpty: () => void;
  onDisconnected: () => void;
}

interface ActiveAudio {
  controller: AbortController;
  fixture: ProgrammaticAudioSource;
  source: AudioSource;
  track: LocalAudioTrack;
  publication: LocalTrackPublication;
  cleanup?: Promise<void>;
}

interface BotVoiceParticipantOptions {
  roomName: string;
  channelId: string;
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
  log: MusicLog;
  lifecycle: VoiceLifecycleCallbacks;
}

export class BotVoiceParticipant implements MusicVoiceParticipant {
  private readonly room = new Room();
  private activeAudio: ActiveAudio | null = null;
  private intentionalDisconnect = false;

  constructor(private readonly options: BotVoiceParticipantOptions) {
    this.room.on(RoomEvent.ParticipantDisconnected, () => {
      if (this.humanParticipantCount() === 0) this.options.lifecycle.onHumansEmpty();
    });
    this.room.on(RoomEvent.Disconnected, () => {
      if (!this.intentionalDisconnect) this.options.lifecycle.onDisconnected();
    });
  }

  get connected(): boolean {
    return this.room.isConnected;
  }

  private humanParticipantCount(): number {
    return Array.from(this.room.remoteParticipants.values()).filter((participant) => {
      const metadata = parseParticipantMetadata(participant.metadata);
      return metadata?.participantType !== 'BOT';
    }).length;
  }

  private async mintToken(): Promise<string> {
    const metadata: BotParticipantMetadata = {
      app: 'sausixudos',
      participantType: 'BOT',
      botId: MUSIC_BOT_IDENTITY,
    };
    const token = new AccessToken(this.options.apiKey, this.options.apiSecret, {
      identity: MUSIC_BOT_IDENTITY,
      name: MUSIC_BOT_DISPLAY_NAME,
      ttl: '10m',
      metadata: JSON.stringify(metadata),
    });
    token.addGrant({
      room: this.options.roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: false,
      canPublishData: true,
    });
    return token.toJwt();
  }

  async connect(): Promise<void> {
    if (this.room.isConnected) return;
    this.intentionalDisconnect = false;
    this.options.log('joining room', {
      room: this.options.roomName,
      channel: this.options.channelId,
    });
    await this.room.connect(this.options.livekitUrl, await this.mintToken(), {
      autoSubscribe: false,
      dynacast: false,
    });
    this.options.log('bot participant connected', {
      room: this.options.roomName,
      channel: this.options.channelId,
    });
    if (this.humanParticipantCount() === 0) {
      queueMicrotask(this.options.lifecycle.onHumansEmpty);
      throw new Error('A sala ficou sem participantes humanos antes da publicação.');
    }
  }

  async startTestAudio(
    initialVolume: number,
    callbacks: PlaybackCallbacks,
  ): Promise<MusicPlaybackHandle> {
    if (!this.room.localParticipant) throw new Error('SausiMusic não está conectado à sala.');
    if (this.activeAudio) throw new Error('SausiMusic já possui uma track ativa nesta sala.');

    const source = new AudioSource(TEST_AUDIO_SAMPLE_RATE, TEST_AUDIO_CHANNELS);
    const track = LocalAudioTrack.createAudioTrack(MUSIC_BOT_TRACK_NAME, source);
    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;
    publishOptions.dtx = false;
    publishOptions.red = true;
    const publication = await this.room.localParticipant.publishTrack(track, publishOptions);
    const fixture = new ProgrammaticAudioSource(initialVolume);
    const active: ActiveAudio = {
      controller: new AbortController(),
      fixture,
      source,
      track,
      publication,
    };
    this.activeAudio = active;
    this.options.log('audio track published', {
      room: this.options.roomName,
      channel: this.options.channelId,
      track: publication.sid ?? MUSIC_BOT_TRACK_NAME,
    });

    void fixture
      .play(
        ({ data, sampleRate, channels, samplesPerChannel }) =>
          source.captureFrame(new AudioFrame(data, sampleRate, channels, samplesPerChannel)),
        active.controller.signal,
      )
      .then(async (result) => {
        if (result === 'finished') await source.waitForPlayout();
        await this.cleanupAudio(active);
        if (result === 'finished') callbacks.onFinished();
      })
      .catch(async (error: unknown) => {
        await this.cleanupAudio(active);
        callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      });

    return {
      get positionMs() {
        return fixture.positionMs;
      },
      pause: () => {
        fixture.pause();
        source.clearQueue();
      },
      resume: () => fixture.resume(),
      setVolume: (volume) => fixture.setVolume(volume),
    };
  }

  private cleanupAudio(active: ActiveAudio): Promise<void> {
    active.cleanup ??= (async () => {
      active.controller.abort();
      active.source.clearQueue();
      if (this.activeAudio === active) this.activeAudio = null;
      const participant = this.room.localParticipant;
      if (participant && active.publication.sid) {
        await participant.unpublishTrack(active.publication.sid, false).catch(() => {});
      }
      await active.track.close().catch(() => {});
      await active.source.close().catch(() => {});
      this.options.log('track unpublished', {
        room: this.options.roomName,
        channel: this.options.channelId,
        track: active.publication.sid ?? MUSIC_BOT_TRACK_NAME,
      });
    })();
    return active.cleanup;
  }

  async stopAudio(): Promise<void> {
    const active = this.activeAudio;
    if (active) await this.cleanupAudio(active);
  }

  async sendMessage(text: string): Promise<void> {
    const participant = this.room.localParticipant;
    if (!participant) return;
    const message: ChatMessage = {
      id: randomUUID(),
      senderId: MUSIC_BOT_IDENTITY,
      senderName: MUSIC_BOT_DISPLAY_NAME,
      text: text.slice(0, CHAT_MESSAGE_MAX_LENGTH),
      sentAt: Date.now(),
    };
    await participant
      .publishData(new TextEncoder().encode(JSON.stringify(message)), {
        reliable: true,
        topic: VOICE_CHAT_TOPIC,
      })
      .catch(() => {});
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    await this.stopAudio();
    if (this.room.isConnected) await this.room.disconnect().catch(() => {});
    this.options.log('bot disconnected', {
      room: this.options.roomName,
      channel: this.options.channelId,
    });
  }
}
