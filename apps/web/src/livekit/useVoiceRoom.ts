import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ConnectionState,
  LocalAudioTrack,
  LocalParticipant,
  Participant,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  TrackPublication,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
} from 'livekit-client';
import {
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatMessage,
  type VoiceChannel,
} from '@sausixudos/shared';
import { api } from '../api';
import { getOutputVolume } from '../appearancePrefs';
import { describeMediaError } from '../mediaAccess';
import { playJoinSound, playLeaveSound, playMessageSound } from '../sounds';

export type ShareQuality = '720p30' | '720p60' | '1080p60';
export type InputMode = 'voice' | 'ptt';

const INPUT_MODE_KEY = 'gc:input-mode';
const PTT_KEY_KEY = 'gc:ptt-key';
const DEFAULT_PTT_KEY = 'ControlRight';
const NOISE_SUPPRESSION_KEY = 'gc:noise-suppression';

function loadNoiseSuppression(): boolean {
  return localStorage.getItem(NOISE_SUPPRESSION_KEY) !== 'false';
}

function microphoneCaptureOptions(noiseSuppression: boolean) {
  return {
    noiseSuppression,
    echoCancellation: true,
    autoGainControl: true,
  } as const;
}

function loadInputMode(): InputMode {
  return localStorage.getItem(INPUT_MODE_KEY) === 'ptt' ? 'ptt' : 'voice';
}

function loadPttKey(): string {
  return localStorage.getItem(PTT_KEY_KEY) || DEFAULT_PTT_KEY;
}

const shareSettings: Record<
  ShareQuality,
  { capture: ScreenShareCaptureOptions; publish: TrackPublishOptions }
> = {
  '720p30': {
    capture: { audio: true, resolution: { width: 1280, height: 720, frameRate: 30 } },
    publish: { videoEncoding: { maxBitrate: 3_000_000, maxFramerate: 30 }, simulcast: true },
  },
  '720p60': {
    capture: { audio: true, resolution: { width: 1280, height: 720, frameRate: 60 } },
    publish: { videoEncoding: { maxBitrate: 5_000_000, maxFramerate: 60 }, simulcast: true },
  },
  '1080p60': {
    capture: { audio: true, resolution: { width: 1920, height: 1080, frameRate: 60 } },
    publish: { videoEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 }, simulcast: true },
  },
};

export interface ScreenTrackView {
  id: string;
  participant: Participant;
  publication: TrackPublication;
}

function isScreenShareCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /invalid capture constraints/i.test(message);
}

export function useVoiceRoom() {
  const initialNoiseSuppression = useRef(loadNoiseSuppression());
  const [room] = useState(
    () =>
      new Room({
        adaptiveStream: true,
        dynacast: true,
        disconnectOnPageLeave: true,
        audioCaptureDefaults: microphoneCaptureOptions(initialNoiseSuppression.current),
      }),
  );
  const [currentChannel, setCurrentChannel] = useState<VoiceChannel | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [speakers, setSpeakers] = useState<Set<string>>(new Set());
  const [screenTracks, setScreenTracks] = useState<ScreenTrackView[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState('');
  const [deafened, setDeafened] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [screenEnabled, setScreenEnabled] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [canPlaybackAudio, setCanPlaybackAudio] = useState(true);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState('default');
  const [selectedSpeakerId, setSelectedSpeakerId] = useState('default');
  const [selectedCameraId, setSelectedCameraId] = useState('default');
  const [inputMode, setInputModeState] = useState<InputMode>(() => loadInputMode());
  const [pttKey, setPttKeyState] = useState(() => loadPttKey());
  const [pttActive, setPttActive] = useState(false);
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(initialNoiseSuppression.current);
  const wasMicEnabled = useRef(true);
  const inputModeRef = useRef(inputMode);
  const pttKeyRef = useRef(pttKey);
  const noiseSuppressionRef = useRef(noiseSuppressionEnabled);
  // Suprime os sons de entrada/saída pra quem já estava no canal antes de
  // você conectar — sem isso, entrar numa call cheia tocaria um bipe pra
  // cada pessoa já presente, tudo de uma vez.
  const suppressPresenceSoundsRef = useRef(true);
  inputModeRef.current = inputMode;
  pttKeyRef.current = pttKey;
  noiseSuppressionRef.current = noiseSuppressionEnabled;

  const syncRoom = useCallback(() => {
    const everyone: Participant[] = [
      room.localParticipant,
      ...Array.from(room.remoteParticipants.values()),
    ];
    setParticipants(everyone);
    setMicEnabled(room.localParticipant.isMicrophoneEnabled);
    setScreenEnabled(room.localParticipant.isScreenShareEnabled);
    setCameraEnabled(room.localParticipant.isCameraEnabled);
    setCanPlaybackAudio(room.canPlaybackAudio);

    const screens: ScreenTrackView[] = [];
    for (const participant of everyone) {
      for (const publication of participant.trackPublications.values()) {
        const isVideoSource =
          publication.source === Track.Source.ScreenShare || publication.source === Track.Source.Camera;
        if (isVideoSource && publication.track) {
          screens.push({
            id: `${participant.identity}-${publication.trackSid}`,
            participant,
            publication,
          });
        }
      }
    }
    setScreenTracks(screens);
  }, [room]);

  useEffect(() => {
    const onActiveSpeakers = (active: Participant[]) => {
      setSpeakers(new Set(active.map((participant) => participant.identity)));
    };
    const onData = (
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ) => {
      if (topic !== 'sausixudos-chat' || !participant) return;
      try {
        const received = JSON.parse(new TextDecoder().decode(payload)) as ChatMessage;
        if (
          typeof received.id === 'string' &&
          typeof received.text === 'string' &&
          received.text.length <= CHAT_MESSAGE_MAX_LENGTH
        ) {
          const message: ChatMessage = {
            id: received.id,
            senderId: participant.identity,
            senderName: participant.name || participant.identity,
            text: received.text,
            sentAt: Date.now(),
          };
          setMessages((current) => [...current.slice(-99), message]);
          playMessageSound(getOutputVolume());
        }
      } catch {
        // Ignora pacotes de dados que não pertencem ao chat.
      }
    };
    const onStateChanged = (state: ConnectionState) => setConnectionState(state);
    const onMediaError = (mediaError: Error) => {
      if (isScreenShareCancelled(mediaError)) return;
      void describeMediaError(mediaError).then(setError);
    };
    const onParticipantConnected = () => {
      syncRoom();
      if (!suppressPresenceSoundsRef.current) playJoinSound(getOutputVolume());
    };
    const onParticipantDisconnected = () => {
      syncRoom();
      if (!suppressPresenceSoundsRef.current) playLeaveSound(getOutputVolume());
    };

    room
      .on(RoomEvent.ParticipantConnected, onParticipantConnected)
      .on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected)
      .on(RoomEvent.TrackSubscribed, syncRoom)
      .on(RoomEvent.TrackUnsubscribed, syncRoom)
      .on(RoomEvent.TrackMuted, syncRoom)
      .on(RoomEvent.TrackUnmuted, syncRoom)
      .on(RoomEvent.LocalTrackPublished, syncRoom)
      .on(RoomEvent.LocalTrackUnpublished, syncRoom)
      .on(RoomEvent.ActiveSpeakersChanged, onActiveSpeakers)
      .on(RoomEvent.DataReceived, onData)
      .on(RoomEvent.ConnectionStateChanged, onStateChanged)
      .on(RoomEvent.MediaDevicesError, onMediaError)
      .on(RoomEvent.AudioPlaybackStatusChanged, syncRoom);

    return () => {
      room.removeAllListeners();
      void room.disconnect();
    };
  }, [room, syncRoom]);

  const refreshDevices = useCallback(async () => {
    const [inputs, outputs, cameras] = await Promise.allSettled([
      Room.getLocalDevices('audioinput'),
      Room.getLocalDevices('audiooutput'),
      Room.getLocalDevices('videoinput'),
    ]);
    // Cada dispositivo é buscado de forma independente: se a câmera falhar
    // (sem webcam, ou em uso por outro app), microfone e saída de áudio
    // continuam sendo preenchidos normalmente.
    if (inputs.status === 'fulfilled') setAudioInputs(inputs.value);
    if (outputs.status === 'fulfilled') setAudioOutputs(outputs.value);
    if (cameras.status === 'fulfilled') setVideoInputs(cameras.value);
  }, []);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
  }, [refreshDevices]);

  useEffect(() => {
    if (connectionState !== ConnectionState.Connected || inputMode !== 'ptt') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== pttKeyRef.current || pttActive) return;
      setPttActive(true);
      void room.localParticipant
        .setMicrophoneEnabled(true, microphoneCaptureOptions(noiseSuppressionRef.current))
        .then(syncRoom);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== pttKeyRef.current) return;
      setPttActive(false);
      void room.localParticipant.setMicrophoneEnabled(false).then(syncRoom);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [connectionState, inputMode, pttActive, room, syncRoom]);

  const connect = useCallback(
    async (channel: VoiceChannel) => {
      if (
        currentChannel?.id === channel.id &&
        room.state === ConnectionState.Connected
      ) {
        return;
      }

      setError('');
      setConnectionState(ConnectionState.Connecting);
      try {
        if (room.state !== ConnectionState.Disconnected) await room.disconnect();
        setMessages([]);
        setDeafened(false);
        const credentials = await api.getLiveKitToken(channel.id);
        suppressPresenceSoundsRef.current = true;
        await room.connect(credentials.url, credentials.token, { autoSubscribe: true });
        setTimeout(() => {
          suppressPresenceSoundsRef.current = false;
        }, 1_500);
        setCurrentChannel(channel);
        try {
          await room.localParticipant.setMicrophoneEnabled(
            true,
            microphoneCaptureOptions(noiseSuppressionRef.current),
          );
          if (inputModeRef.current === 'ptt') {
            await room.localParticipant.setMicrophoneEnabled(false);
          }
          void refreshDevices();
        } catch (mediaError) {
          setError(`${await describeMediaError(mediaError, 'microphone')} Você entrou com o microfone desligado.`);
        }
        syncRoom();
      } catch (connectError) {
        await room.disconnect();
        setCurrentChannel(null);
        setError(
          connectError instanceof Error
            ? connectError.message
            : 'Não foi possível entrar no canal de voz.',
        );
      }
    },
    [currentChannel, room, syncRoom, refreshDevices],
  );

  const disconnect = useCallback(async () => {
    await room.disconnect();
    setCurrentChannel(null);
    setParticipants([]);
    setMessages([]);
    setSpeakers(new Set());
    setDeafened(false);
    setMicEnabled(false);
    setScreenEnabled(false);
    setCameraEnabled(false);
    setScreenTracks([]);
  }, [room, syncRoom]);

  const toggleMicrophone = useCallback(async () => {
    if (deafened) return;
    setError('');
    try {
      const enabled = !room.localParticipant.isMicrophoneEnabled;
      await room.localParticipant.setMicrophoneEnabled(
        enabled,
        enabled ? microphoneCaptureOptions(noiseSuppressionRef.current) : undefined,
      );
      syncRoom();
    } catch (mediaError) {
      setError(await describeMediaError(mediaError, 'microphone'));
    }
  }, [deafened, room, syncRoom]);

  const toggleDeafen = useCallback(async () => {
    setError('');
    const next = !deafened;
    try {
      if (next) {
        wasMicEnabled.current = room.localParticipant.isMicrophoneEnabled;
        await room.localParticipant.setMicrophoneEnabled(false);
      } else if (wasMicEnabled.current) {
        await room.localParticipant.setMicrophoneEnabled(
          true,
          microphoneCaptureOptions(noiseSuppressionRef.current),
        );
      }
      setDeafened(next);
      syncRoom();
    } catch (mediaError) {
      setError(await describeMediaError(mediaError, 'microphone'));
    }
  }, [deafened, room, syncRoom]);

  const setInputMode = useCallback(
    (mode: InputMode) => {
      localStorage.setItem(INPUT_MODE_KEY, mode);
      setInputModeState(mode);
      if (mode === 'voice' && connectionState === ConnectionState.Connected) {
        void room.localParticipant
          .setMicrophoneEnabled(true, microphoneCaptureOptions(noiseSuppressionRef.current))
          .then(syncRoom);
      } else if (mode === 'ptt' && connectionState === ConnectionState.Connected) {
        void room.localParticipant.setMicrophoneEnabled(false).then(syncRoom);
      }
    },
    [connectionState, room, syncRoom],
  );

  const setPttKeyBinding = useCallback((code: string) => {
    localStorage.setItem(PTT_KEY_KEY, code);
    setPttKeyState(code);
  }, []);

  const setNoiseSuppression = useCallback(
    async (enabled: boolean) => {
      localStorage.setItem(NOISE_SUPPRESSION_KEY, String(enabled));
      noiseSuppressionRef.current = enabled;
      setNoiseSuppressionEnabled(enabled);
      const captureOptions = microphoneCaptureOptions(enabled);
      room.options.audioCaptureDefaults = {
        ...room.options.audioCaptureDefaults,
        ...captureOptions,
      };
      const microphone = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      if (microphone instanceof LocalAudioTrack) {
        try {
          await microphone.applyConstraints(captureOptions);
          setError('');
        } catch (mediaError) {
          setError(await describeMediaError(mediaError, 'microphone'));
        }
      }
    },
    [room],
  );

  const setMicrophoneDevice = useCallback(
    async (deviceId: string) => {
      setSelectedMicId(deviceId);
      await room.switchActiveDevice('audioinput', deviceId);
    },
    [room],
  );

  const setSpeakerDevice = useCallback(
    async (deviceId: string) => {
      setSelectedSpeakerId(deviceId);
      await room.switchActiveDevice('audiooutput', deviceId);
    },
    [room],
  );

  const setCameraDevice = useCallback(
    async (deviceId: string) => {
      setSelectedCameraId(deviceId);
      await room.switchActiveDevice('videoinput', deviceId);
    },
    [room],
  );

  const toggleCamera = useCallback(async () => {
    setError('');
    try {
      await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled);
      syncRoom();
    } catch (mediaError) {
      setError(await describeMediaError(mediaError, 'camera'));
    }
  }, [room, syncRoom]);

  const toggleScreenShare = useCallback(
    async (quality: ShareQuality, shareAudio = true) => {
      setError('');
      try {
        if (room.localParticipant.isScreenShareEnabled) {
          await room.localParticipant.setScreenShareEnabled(false);
        } else {
          const settings = shareSettings[quality];
          await room.localParticipant.setScreenShareEnabled(true, { ...settings.capture, audio: shareAudio }, settings.publish);
        }
        syncRoom();
      } catch (mediaError) {
        if (!isScreenShareCancelled(mediaError)) {
          setError(await describeMediaError(mediaError));
        }
        syncRoom();
      }
    },
    [room, syncRoom],
  );

  const sendMessage = useCallback(
    async (rawText: string) => {
      const text = rawText.trim().slice(0, CHAT_MESSAGE_MAX_LENGTH);
      if (!text || room.state !== ConnectionState.Connected) return;

      const message: ChatMessage = {
        id: crypto.randomUUID(),
        senderId: room.localParticipant.identity,
        senderName: room.localParticipant.name || room.localParticipant.identity,
        text,
        sentAt: Date.now(),
      };
      await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(message)), {
        reliable: true,
        topic: 'sausixudos-chat',
      });
      setMessages((current) => [...current.slice(-99), message]);
    },
    [room],
  );

  const connected = connectionState === ConnectionState.Connected;

  return useMemo(
    () => ({
      room,
      currentChannel,
      connectionState,
      connected,
      participants,
      speakers,
      screenTracks,
      messages,
      error,
      clearError: () => setError(''),
      deafened,
      micEnabled,
      screenEnabled,
      cameraEnabled,
      canPlaybackAudio,
      audioInputs,
      audioOutputs,
      videoInputs,
      selectedMicId,
      selectedSpeakerId,
      selectedCameraId,
      inputMode,
      pttKey,
      pttActive,
      noiseSuppressionEnabled,
      setInputMode,
      setPttKeyBinding,
      setNoiseSuppression,
      setMicrophoneDevice,
      setSpeakerDevice,
      setCameraDevice,
      refreshDevices,
      connect,
      disconnect,
      toggleMicrophone,
      toggleDeafen,
      toggleCamera,
      toggleScreenShare,
      sendMessage,
      startAudio: () => room.startAudio().then(syncRoom),
    }),
    [
      room,
      currentChannel,
      connectionState,
      connected,
      participants,
      speakers,
      screenTracks,
      messages,
      error,
      deafened,
      micEnabled,
      screenEnabled,
      cameraEnabled,
      canPlaybackAudio,
      audioInputs,
      audioOutputs,
      videoInputs,
      selectedMicId,
      selectedSpeakerId,
      selectedCameraId,
      inputMode,
      pttKey,
      pttActive,
      noiseSuppressionEnabled,
      setInputMode,
      setPttKeyBinding,
      setNoiseSuppression,
      setMicrophoneDevice,
      setSpeakerDevice,
      setCameraDevice,
      refreshDevices,
      connect,
      disconnect,
      toggleMicrophone,
      toggleDeafen,
      toggleCamera,
      toggleScreenShare,
      sendMessage,
      syncRoom,
    ],
  );
}

export type VoiceRoomController = ReturnType<typeof useVoiceRoom>;
export { LocalParticipant };
