import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ConnectionState,
  LocalAudioTrack,
  LocalParticipant,
  Participant,
  RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  TrackPublication,
  VideoPresets,
  type AudioCaptureOptions,
  type AudioProcessorOptions,
  type ScreenShareCaptureOptions,
  type TrackProcessor,
  type TrackPublishOptions,
} from 'livekit-client';
import type { KrispNoiseFilterProcessor } from '@livekit/krisp-noise-filter';
import {
  CHAT_MESSAGE_MAX_LENGTH,
  MUSIC_BOT_DISPLAY_NAME,
  MUSIC_BOT_IDENTITY,
  parseParticipantMetadata,
  VOICE_CHAT_TOPIC,
  type Activity,
  type ChatMessage,
  type VoiceChannel,
} from '@sausixudos/shared';
import { api } from '../api';
import { getOutputVolume } from '../appearancePrefs';
import { describeMediaError } from '../mediaAccess';
import { routeVoiceChatInput } from '../musicCommandRouting';
import {
  playJoinSound,
  playLeaveSound,
  playMessageSound,
  playMicMuteSound,
  playMicUnmuteSound,
  playScreenShareStartSound,
  playScreenShareStopSound,
} from '../sounds';

export type ShareQuality = '720p30' | '720p60' | '1080p60';
export type InputMode = 'voice' | 'ptt';

const INPUT_MODE_KEY = 'gc:input-mode';
const PTT_KEY_KEY = 'gc:ptt-key';
const DEFAULT_PTT_KEY = 'ControlRight';
const NOISE_SUPPRESSION_KEY = 'gc:noise-suppression';
const ECHO_CANCELLATION_KEY = 'gc:echo-cancellation';
const AUTO_GAIN_KEY = 'gc:auto-gain';
const MIC_PROFILE_KEY = 'gc:mic-profile';
const AUTO_SENSITIVITY_KEY = 'gc:auto-sensitivity';
const INPUT_SENSITIVITY_KEY = 'gc:input-sensitivity';

/**
 * Espelha os 3 perfis do Discord. A supressão de ruído usa o Krisp de
 * verdade (@livekit/krisp-noise-filter, o mesmo motor que o Discord usa —
 * roda localmente no navegador via WASM, não é um serviço pago por
 * requisição) sempre que o navegador suportar; sem suporte, cai pra
 * supressão nativa do Chromium como alternativa. "Personalizado" expõe
 * supressão/eco/ganho individualmente.
 */
export type MicProfile = 'isolamento' | 'estudio' | 'personalizado';

// @livekit/krisp-noise-filter empacota o modelo Krisp (~6MB) dentro do
// próprio módulo JS — um import estático incharia o bundle principal do app
// inteiro pra todo mundo, mesmo quem nunca abre um canal de voz. import()
// dinâmico vira um chunk separado que só baixa quando alguém realmente entra
// numa call, disparado assim que este módulo carrega (não só no primeiro
// uso) pra já estar pronto quando a pessoa terminar de escolher o canal.
let krispSupported = false;
let krispModulePromise: ReturnType<typeof loadKrispModule> | null = null;

function loadKrispModule() {
  return import('@livekit/krisp-noise-filter').then((module) => {
    krispSupported = module.isKrispNoiseFilterSupported();
    return module;
  });
}

function ensureKrispModule() {
  krispModulePromise ??= loadKrispModule().catch((error) => {
    krispSupported = false;
    krispModulePromise = null;
    throw error;
  });
  return krispModulePromise;
}

void ensureKrispModule();

function wantsRealNoiseSuppression(profile: MicProfile, noiseSuppression: boolean): boolean {
  if (profile === 'estudio') return false;
  if (profile === 'isolamento') return true;
  return noiseSuppression;
}

function loadMicProfile(): MicProfile {
  const stored = localStorage.getItem(MIC_PROFILE_KEY);
  if (stored === 'estudio' || stored === 'personalizado') return stored;
  if (stored === 'isolamento') return 'isolamento';
  // Ninguém escolheu um perfil ainda: quem já tinha desligado a supressão de
  // ruído no toggle antigo (única opção que existia antes desse recurso) cai
  // em "Personalizado" pra manter exatamente o que essa pessoa já preferia,
  // em vez de reativar a supressão silenciosamente com o padrão "Isolamento".
  return localStorage.getItem(NOISE_SUPPRESSION_KEY) === 'false' ? 'personalizado' : 'isolamento';
}

function loadNoiseSuppression(): boolean {
  return localStorage.getItem(NOISE_SUPPRESSION_KEY) !== 'false';
}

function loadEchoCancellation(): boolean {
  return localStorage.getItem(ECHO_CANCELLATION_KEY) !== 'false';
}

function loadAutoGain(): boolean {
  return localStorage.getItem(AUTO_GAIN_KEY) !== 'false';
}

function loadAutoSensitivity(): boolean {
  return localStorage.getItem(AUTO_SENSITIVITY_KEY) !== 'false';
}

function loadInputSensitivity(): number {
  const stored = localStorage.getItem(INPUT_SENSITIVITY_KEY);
  const value = stored === null ? NaN : Number(stored);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 15;
}

function microphoneCaptureOptions(
  profile: MicProfile,
  noiseSuppression: boolean,
  echoCancellation: boolean,
  autoGain: boolean,
) {
  if (profile === 'estudio') {
    // "Áudio puro": igual ao Discord, mic aberto sem nenhum processamento.
    return { noiseSuppression: false, echoCancellation: false, autoGainControl: false };
  }
  const suppressionWanted = wantsRealNoiseSuppression(profile, noiseSuppression);
  return {
    // O Krisp roda como processor sobre o track já publicado (attachKrispProcessor),
    // não como constraint de captura — pedir os dois ao mesmo tempo cascateia
    // dois DSPs de ruído diferentes, o que soa pior, não melhor. A constraint
    // nativa só entra quando o Krisp não pôde carregar.
    noiseSuppression: suppressionWanted && !krispSupported,
    echoCancellation: profile === 'isolamento' ? true : echoCancellation,
    autoGainControl: profile === 'isolamento' ? true : autoGain,
  };
}

function loadInputMode(): InputMode {
  return localStorage.getItem(INPUT_MODE_KEY) === 'ptt' ? 'ptt' : 'voice';
}

function loadPttKey(): string {
  return localStorage.getItem(PTT_KEY_KEY) || DEFAULT_PTT_KEY;
}

// echoCancellation/noiseSuppression/autoGainControl são DSP de voz — aplicados
// no áudio do sistema/aba (jogo, música, vídeo), eles abafam e comprimem o som
// exatamente como um microfone de telefone, o efeito de "dentro de uma caixa"
// que estava sendo reportado. Áudio de tela não é voz, então desligamos os três.
//
// restrictOwnAudio é uma constraint real do Chromium (suportada no Windows a
// partir do Electron 44): filtra do áudio capturado por loopback qualquer som
// que tenha se originado do NOSSO PRÓPRIO app — inclui a voz de quem estiver
// na call tocando pelos alto-falantes de quem compartilha. É o motivo de
// alguém ouvir a própria voz (ou a de outros) voltando pela transmissão de
// quem compartilha: sem isso, o loopback pega literalmente tudo que sai pelo
// áudio do sistema, call incluída. Com isso, só o conteúdo real da tela
// compartilhada (jogo, vídeo, música) deveria ser capturado.
const SCREEN_SHARE_AUDIO_CAPTURE = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  restrictOwnAudio: true,
} as AudioCaptureOptions & { restrictOwnAudio?: boolean };

// audioPreset padrão do LiveKit pra qualquer publicação de áudio é otimizado
// pra voz (bitrate baixo); música/jogo precisa de bitrate de música de
// verdade — 320kbps é o teto prático do Opus estéreo (bem acima disso não
// tem ganho perceptível, o codec já fica transparente bem antes) — e dtx
// (que trata trechos "quietos" como silêncio e para de mandar dados) corta
// partes baixas de música, então fica desligado aqui.
const SCREEN_SHARE_AUDIO_PUBLISH = {
  audioPreset: { maxBitrate: 320_000 },
  dtx: false,
  red: true,
} as const;

const shareSettings: Record<
  ShareQuality,
  { capture: ScreenShareCaptureOptions; publish: TrackPublishOptions }
> = {
  '720p30': {
    capture: { audio: SCREEN_SHARE_AUDIO_CAPTURE, resolution: { width: 1280, height: 720, frameRate: 30 } },
    // simulcast (várias camadas de qualidade) é ótimo pra câmera vista por
    // gente com conexões bem diferentes, mas pra tela compartilhada, com
    // texto/detalhe, só atrapalha — o SFU pode escolher uma camada mais
    // fraca por padrão. Uma única camada de alta qualidade fica mais nítida.
    publish: { videoEncoding: { maxBitrate: 4_000_000, maxFramerate: 30 }, simulcast: false, ...SCREEN_SHARE_AUDIO_PUBLISH },
  },
  '720p60': {
    capture: { audio: SCREEN_SHARE_AUDIO_CAPTURE, resolution: { width: 1280, height: 720, frameRate: 60 } },
    publish: { videoEncoding: { maxBitrate: 7_000_000, maxFramerate: 60 }, simulcast: false, ...SCREEN_SHARE_AUDIO_PUBLISH },
  },
  '1080p60': {
    capture: { audio: SCREEN_SHARE_AUDIO_CAPTURE, resolution: { width: 1920, height: 1080, frameRate: 60 } },
    publish: { videoEncoding: { maxBitrate: 12_000_000, maxFramerate: 60 }, simulcast: false, ...SCREEN_SHARE_AUDIO_PUBLISH },
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
  const initialMicProfile = useRef(loadMicProfile());
  const initialNoiseSuppression = useRef(loadNoiseSuppression());
  const initialEchoCancellation = useRef(loadEchoCancellation());
  const initialAutoGain = useRef(loadAutoGain());
  const [room] = useState(
    () =>
      new Room({
        // adaptiveStream reduz a resolução recebida com base no tamanho do
        // elemento <video> na tela — útil pra economizar banda, mas troca
        // nitidez por isso, e foi apontado como causa da imagem borrada.
        adaptiveStream: false,
        dynacast: true,
        disconnectOnPageLeave: true,
        audioCaptureDefaults: microphoneCaptureOptions(
          initialMicProfile.current,
          initialNoiseSuppression.current,
          initialEchoCancellation.current,
          initialAutoGain.current,
        ),
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
  // Captura de áudio do sistema (loopback) pega tudo que sai pelo alto-falante
  // de quem compartilha — incluindo a voz dos outros que o próprio app está
  // tocando pra ela. Não dá pra filtrar isso no Windows sem um driver de
  // áudio virtual, então a saída é mutar localmente (só pra quem compartilha)
  // enquanto o áudio do sistema estiver indo junto, senão vaza de volta.
  const [shareAudioActive, setShareAudioActive] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [canPlaybackAudio, setCanPlaybackAudio] = useState(true);
  const [krispReady, setKrispReady] = useState(krispSupported);

  useEffect(() => {
    ensureKrispModule()
      .then(() => setKrispReady(krispSupported))
      .catch(() => setKrispReady(false));
  }, []);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState('default');
  const [selectedSpeakerId, setSelectedSpeakerId] = useState('default');
  const [selectedCameraId, setSelectedCameraId] = useState('default');
  const [inputMode, setInputModeState] = useState<InputMode>(() => loadInputMode());
  const [pttKey, setPttKeyState] = useState(() => loadPttKey());
  const [pttActive, setPttActive] = useState(false);
  const [micProfile, setMicProfileState] = useState<MicProfile>(initialMicProfile.current);
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(initialNoiseSuppression.current);
  const [echoCancellationEnabled, setEchoCancellationEnabled] = useState(initialEchoCancellation.current);
  const [autoGainEnabled, setAutoGainEnabled] = useState(initialAutoGain.current);
  const [autoSensitivity, setAutoSensitivityState] = useState(() => loadAutoSensitivity());
  const [inputSensitivity, setInputSensitivityState] = useState(() => loadInputSensitivity());
  const wasMicEnabled = useRef(true);
  const inputModeRef = useRef(inputMode);
  const pttKeyRef = useRef(pttKey);
  const micProfileRef = useRef(micProfile);
  const noiseSuppressionRef = useRef(noiseSuppressionEnabled);
  const echoCancellationRef = useRef(echoCancellationEnabled);
  const autoGainRef = useRef(autoGainEnabled);
  const inputSensitivityRef = useRef(inputSensitivity);
  const deafenedRef = useRef(false);
  const krispProcessorRef = useRef<KrispNoiseFilterProcessor | null>(null);
  // Última atividade conhecida (jogo/mídia), reportada pelo app desktop —
  // guardada aqui pra poder ser aplicada assim que uma conexão é aberta,
  // já que o metadata inicial do token sempre chega com activity: null (o
  // servidor não tem como saber o que está rodando na sua máquina).
  const lastActivityRef = useRef<Activity | null>(null);
  // Suprime os sons de entrada/saída pra quem já estava no canal antes de
  // você conectar — sem isso, entrar numa call cheia tocaria um bipe pra
  // cada pessoa já presente, tudo de uma vez.
  const suppressPresenceSoundsRef = useRef(true);
  inputModeRef.current = inputMode;
  pttKeyRef.current = pttKey;
  micProfileRef.current = micProfile;
  noiseSuppressionRef.current = noiseSuppressionEnabled;
  echoCancellationRef.current = echoCancellationEnabled;
  autoGainRef.current = autoGainEnabled;
  inputSensitivityRef.current = inputSensitivity;
  deafenedRef.current = deafened;

  const currentMicCaptureOptions = useCallback(
    () =>
      microphoneCaptureOptions(
        micProfileRef.current,
        noiseSuppressionRef.current,
        echoCancellationRef.current,
        autoGainRef.current,
      ),
    [],
  );

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
    const removeSpeaker = (identity: string) => {
      setSpeakers((current) => {
        if (!current.has(identity)) return current;
        const next = new Set(current);
        next.delete(identity);
        return next;
      });
    };
    const onActiveSpeakers = (active: Participant[]) => {
      setSpeakers(new Set(active.map((participant) => participant.identity)));
    };
    const onData = (
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ) => {
      if (topic !== VOICE_CHAT_TOPIC || !participant) return;
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
    const onParticipantDisconnected = (participant: RemoteParticipant) => {
      removeSpeaker(participant.identity);
      syncRoom();
      if (!suppressPresenceSoundsRef.current) playLeaveSound(getOutputVolume());
    };
    const onTrackUnsubscribed = (
      _track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (publication.source === Track.Source.Microphone) removeSpeaker(participant.identity);
      syncRoom();
    };
    const onTrackMuted = (publication: TrackPublication, participant: Participant) => {
      if (publication.source === Track.Source.Microphone) removeSpeaker(participant.identity);
      syncRoom();
    };
    // Cobre o caso de parar o compartilhamento pela barra nativa do Windows/
    // navegador em vez do nosso botão — sem isso, o mudo ficava travado. É
    // também o único lugar que toca o som de "parar transmissão": tanto o
    // botão quanto a barra nativa acabam disparando este mesmo evento, então
    // tocar o som aqui (em vez de no botão também) evita ele tocar em dobro.
    const onLocalTrackUnpublished = (publication: TrackPublication) => {
      if (publication.source === Track.Source.ScreenShare) {
        playScreenShareStopSound(getOutputVolume());
      }
      if (publication.source === Track.Source.ScreenShare || publication.source === Track.Source.ScreenShareAudio) {
        setShareAudioActive(false);
      }
      syncRoom();
    };
    // O Krisp se prende ao track de microfone publicado (via setProcessor,
    // que troca o sender por baixo dos panos) — precisa ser reanexado a cada
    // publish porque reconectar cria um LocalAudioTrack novo. Troca de
    // dispositivo NÃO passa por aqui: o próprio LiveKit reinicializa o
    // processor já anexado quando o track é trocado.
    const onLocalTrackPublished = (publication: TrackPublication) => {
      if (publication.source !== Track.Source.Microphone) return;
      const track = publication.track;
      if (!(track instanceof LocalAudioTrack)) return;
      void ensureKrispModule()
        .then(({ KrispNoiseFilter }) => {
          if (!krispSupported) return;
          const processor = KrispNoiseFilter({ quality: 'medium' });
          const previous = krispProcessorRef.current;
          krispProcessorRef.current = processor;
          // @livekit/krisp-noise-filter tipa `processedTrack` como
          // `T | undefined` explícito; o `TrackProcessor` do livekit-client
          // tipa como opcional simples — sob exactOptionalPropertyTypes isso
          // é só uma divergência entre as declarações dos dois pacotes, não
          // uma incompatibilidade real (é o processor oficial da LiveKit).
          return track
            .setProcessor(processor as TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>)
            .then(() => processor.setEnabled(wantsRealNoiseSuppression(micProfileRef.current, noiseSuppressionRef.current)))
            .then(() => void previous?.destroy())
            .catch(() => {
              if (krispProcessorRef.current === processor) krispProcessorRef.current = null;
            });
        })
        .catch(() => {
          // Sem Krisp disponível: microphoneCaptureOptions() já usa a
          // supressão nativa do navegador como alternativa nesse caso.
        });
    };

    room
      .on(RoomEvent.ParticipantConnected, onParticipantConnected)
      .on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected)
      .on(RoomEvent.ParticipantMetadataChanged, syncRoom)
      .on(RoomEvent.TrackSubscribed, syncRoom)
      .on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
      .on(RoomEvent.TrackMuted, onTrackMuted)
      .on(RoomEvent.TrackUnmuted, syncRoom)
      .on(RoomEvent.LocalTrackPublished, syncRoom)
      .on(RoomEvent.LocalTrackPublished, onLocalTrackPublished)
      .on(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished)
      .on(RoomEvent.ActiveSpeakersChanged, onActiveSpeakers)
      .on(RoomEvent.DataReceived, onData)
      .on(RoomEvent.ConnectionStateChanged, onStateChanged)
      .on(RoomEvent.MediaDevicesError, onMediaError)
      .on(RoomEvent.AudioPlaybackStatusChanged, syncRoom);

    return () => {
      room.removeAllListeners();
      void room.disconnect();
      void krispProcessorRef.current?.destroy();
      krispProcessorRef.current = null;
    };
  }, [room, syncRoom]);

  // Publica a atividade (jogo/mídia) no próprio metadata do participante —
  // setMetadata dispara ParticipantMetadataChanged pra todo mundo na sala
  // (o listener já registrado acima chama syncRoom sozinho), sem precisar
  // de nenhum canal separado pra isso.
  const applyActivity = useCallback(
    (activity: Activity | null) => {
      lastActivityRef.current = activity;
      if (room.state !== ConnectionState.Connected) return;
      const current = parseParticipantMetadata(room.localParticipant.metadata);
      if (!current || current.participantType !== 'HUMAN') return;
      void room.localParticipant.setMetadata(JSON.stringify({ ...current, activity }));
    },
    [room],
  );

  useEffect(() => {
    // A primeira detecção pode acontecer antes deste efeito montar (ex.:
    // alguém que já estava com o Spotify tocando antes mesmo da janela
    // abrir) — nesse caso o "push" via onActivityChanged já passou e se
    // perdeu no ar, então também puxamos o valor atual explicitamente aqui.
    void window.desktop?.getCurrentActivity?.().then((activity) => applyActivity(activity ?? null));
    return window.desktop?.onActivityChanged?.(applyActivity);
  }, [applyActivity]);

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
        .setMicrophoneEnabled(true, currentMicCaptureOptions())
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

  // "Sensibilidade de entrada" (perfil Personalizado, modo Voz ativa): igual
  // ao gate de ruído do Discord. Abre uma captura própria (independente do
  // track publicado) só pra medir o nível do microfone — assim conseguimos
  // decidir quando ligar/desligar o microfone publicado sem travar a
  // detecção (um MediaStreamTrack desabilitado também para de gerar dados
  // pro analisador, então monitorar o próprio track publicado não funciona).
  useEffect(() => {
    if (connectionState !== ConnectionState.Connected || inputMode !== 'voice' || micProfile !== 'personalizado') {
      return;
    }

    let cancelled = false;
    let audioContext: AudioContext | undefined;
    let stream: MediaStream | undefined;
    let rafId = 0;
    let gateOpen = true;
    let lastLoudAt = Date.now();
    let calibratedThreshold: number | null = null;
    const calibrationSamples: number[] = [];
    const calibrationStart = Date.now();
    const HANGOVER_MS = 400;
    const CALIBRATION_MS = 1500;

    async function start() {
      try {
        const constraints: MediaStreamConstraints = {
          audio: selectedMicId === 'default' ? true : { deviceId: { exact: selectedMicId } },
        };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          if (cancelled) return;
          analyser.getByteFrequencyData(data);
          const average = data.reduce((sum, value) => sum + value, 0) / data.length;
          const level = Math.min(100, Math.round((average / 160) * 100));

          let effectiveThreshold: number | null;
          if (autoSensitivity) {
            if (calibratedThreshold === null) {
              calibrationSamples.push(level);
              if (Date.now() - calibrationStart >= CALIBRATION_MS) {
                const floor = calibrationSamples.reduce((sum, value) => sum + value, 0) / calibrationSamples.length;
                calibratedThreshold = Math.min(60, Math.max(6, floor + 12));
              }
            }
            effectiveThreshold = calibratedThreshold;
          } else {
            effectiveThreshold = inputSensitivityRef.current;
          }

          if (effectiveThreshold !== null && !deafenedRef.current) {
            const now = Date.now();
            if (level > effectiveThreshold) lastLoudAt = now;
            const shouldBeOpen = now - lastLoudAt < HANGOVER_MS;
            if (shouldBeOpen !== gateOpen) {
              gateOpen = shouldBeOpen;
              void room.localParticipant
                .setMicrophoneEnabled(gateOpen, gateOpen ? currentMicCaptureOptions() : undefined)
                .then(syncRoom);
            }
          }
          rafId = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // Sem acesso pra monitorar o nível — a sensibilidade de entrada não
        // atua, mas o resto da chamada continua funcionando normalmente.
      }
    }

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((track) => track.stop());
      void audioContext?.close();
      // Se o gate tinha fechado o microfone, devolve pro estado normal
      // (ligado) ao sair desse modo — senão a pessoa ficaria muda sem saber.
      if (!gateOpen) {
        void room.localParticipant.setMicrophoneEnabled(true, currentMicCaptureOptions()).then(syncRoom);
      }
    };
  }, [connectionState, inputMode, micProfile, autoSensitivity, selectedMicId, room, syncRoom, currentMicCaptureOptions]);

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
            currentMicCaptureOptions(),
          );
          if (inputModeRef.current === 'ptt') {
            await room.localParticipant.setMicrophoneEnabled(false);
          }
          void refreshDevices();
        } catch (mediaError) {
          setError(`${await describeMediaError(mediaError, 'microphone')} Você entrou com o microfone desligado.`);
        }
        syncRoom();
        // O token sempre chega com activity: null (o servidor não sabe o que
        // está rodando na sua máquina) — aplica a última atividade conhecida
        // assim que a conexão abre, senão ela só apareceria pros outros na
        // próxima vez que o app desktop detectasse uma mudança.
        applyActivity(lastActivityRef.current);
        // Toca só agora, depois do mic já publicado (ou já ter desistido dele)
        // — é o mesmo ponto em que a tela de "Entrando na sala..." some, então
        // o som acompanha o momento real em que você está dentro, em vez de
        // disparar cedo enquanto a UI ainda mostra carregando. Isso também
        // cobre troca de canal, que passa por aqui de novo.
        playJoinSound(getOutputVolume());
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
    [currentChannel, room, syncRoom, refreshDevices, applyActivity],
  );

  const disconnect = useCallback(async () => {
    const wasConnected = Boolean(currentChannel);
    await room.disconnect();
    // Só depois de desconectar de verdade — soar isso antes fazia o áudio
    // "confirmar a saída" enquanto você ainda estava tecnicamente na sala.
    if (wasConnected) playLeaveSound(getOutputVolume());
    setCurrentChannel(null);
    setParticipants([]);
    setMessages([]);
    setSpeakers(new Set());
    setDeafened(false);
    setMicEnabled(false);
    setScreenEnabled(false);
    setCameraEnabled(false);
    setScreenTracks([]);
  }, [currentChannel, room, syncRoom]);

  const toggleMicrophone = useCallback(async () => {
    if (deafened) return;
    setError('');
    try {
      const enabled = !room.localParticipant.isMicrophoneEnabled;
      await room.localParticipant.setMicrophoneEnabled(
        enabled,
        enabled ? currentMicCaptureOptions() : undefined,
      );
      (enabled ? playMicUnmuteSound : playMicMuteSound)(getOutputVolume());
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
          currentMicCaptureOptions(),
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
          .setMicrophoneEnabled(true, currentMicCaptureOptions())
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

  // Reaplica as constraints de captura (perfil + os 3 toggles individuais do
  // modo Personalizado) no track de microfone já publicado, sem precisar
  // reconectar — usado por todo setter de perfil/supressão/eco/ganho abaixo.
  const applyMicCaptureOptions = useCallback(async () => {
    const captureOptions = currentMicCaptureOptions();
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
  }, [room, currentMicCaptureOptions]);

  const setMicProfile = useCallback(
    (profile: MicProfile) => {
      localStorage.setItem(MIC_PROFILE_KEY, profile);
      micProfileRef.current = profile;
      setMicProfileState(profile);
      void applyMicCaptureOptions();
      void krispProcessorRef.current?.setEnabled(wantsRealNoiseSuppression(profile, noiseSuppressionRef.current));
    },
    [applyMicCaptureOptions],
  );

  const setNoiseSuppression = useCallback(
    (enabled: boolean) => {
      localStorage.setItem(NOISE_SUPPRESSION_KEY, String(enabled));
      noiseSuppressionRef.current = enabled;
      setNoiseSuppressionEnabled(enabled);
      void applyMicCaptureOptions();
      void krispProcessorRef.current?.setEnabled(wantsRealNoiseSuppression(micProfileRef.current, enabled));
    },
    [applyMicCaptureOptions],
  );

  const setEchoCancellation = useCallback(
    (enabled: boolean) => {
      localStorage.setItem(ECHO_CANCELLATION_KEY, String(enabled));
      echoCancellationRef.current = enabled;
      setEchoCancellationEnabled(enabled);
      void applyMicCaptureOptions();
    },
    [applyMicCaptureOptions],
  );

  const setAutoGain = useCallback(
    (enabled: boolean) => {
      localStorage.setItem(AUTO_GAIN_KEY, String(enabled));
      autoGainRef.current = enabled;
      setAutoGainEnabled(enabled);
      void applyMicCaptureOptions();
    },
    [applyMicCaptureOptions],
  );

  const setAutoSensitivity = useCallback((enabled: boolean) => {
    localStorage.setItem(AUTO_SENSITIVITY_KEY, String(enabled));
    setAutoSensitivityState(enabled);
  }, []);

  const setInputSensitivity = useCallback((value: number) => {
    const clamped = Math.min(100, Math.max(0, Math.round(value)));
    localStorage.setItem(INPUT_SENSITIVITY_KEY, String(clamped));
    inputSensitivityRef.current = clamped;
    setInputSensitivityState(clamped);
  }, []);

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
      await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled, {
        resolution: VideoPresets.h1080.resolution,
      }, {
        videoEncoding: VideoPresets.h1080.encoding,
        simulcast: true,
      });
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
          setShareAudioActive(false);
        } else {
          const settings = shareSettings[quality];
          await room.localParticipant.setScreenShareEnabled(
            true,
            { ...settings.capture, audio: shareAudio ? SCREEN_SHARE_AUDIO_CAPTURE : false },
            settings.publish,
          );
          // "detail" pede pro navegador priorizar nitidez espacial em vez de
          // suavidade de movimento ao codificar — o certo pra texto/UI numa
          // tela compartilhada, que não se move como um vídeo de câmera.
          const screenTrack = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
          const mediaStreamTrack = screenTrack?.mediaStreamTrack;
          if (mediaStreamTrack && 'contentHint' in mediaStreamTrack) {
            mediaStreamTrack.contentHint = 'detail';
          }
          const audioPublished = Boolean(
            room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio),
          );
          setShareAudioActive(audioPublished);
          playScreenShareStartSound(getOutputVolume());
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

      setError('');
      try {
        const result = await routeVoiceChatInput({
          text,
          voiceChannelId: currentChannel?.id ?? null,
          sendMusicCommand: api.sendMusicCommand,
          publishChatMessage: async (messageText) => {
            const message: ChatMessage = {
              id: crypto.randomUUID(),
              senderId: room.localParticipant.identity,
              senderName: room.localParticipant.name || room.localParticipant.identity,
              text: messageText,
              sentAt: Date.now(),
            };
            await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(message)), {
              reliable: true,
              topic: VOICE_CHAT_TOPIC,
            });
            setMessages((current) => [...current.slice(-99), message]);
          },
        });
        if (result.kind === 'music-command') {
          const feedback: ChatMessage = {
            id: crypto.randomUUID(),
            senderId: MUSIC_BOT_IDENTITY,
            senderName: MUSIC_BOT_DISPLAY_NAME,
            text: result.response.message,
            sentAt: Date.now(),
            ...(result.response.nowPlaying ? { musicCard: result.response.nowPlaying } : {}),
          };
          setMessages((current) => [...current.slice(-99), feedback]);
        }
      } catch (commandError) {
        setError(
          commandError instanceof Error
            ? commandError.message
            : 'Não foi possível encaminhar o comando ao SausiMusic.',
        );
        throw commandError;
      }
    },
    [currentChannel?.id, room],
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
      shareAudioActive,
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
      micProfile,
      krispSupported: krispReady,
      noiseSuppressionEnabled,
      echoCancellationEnabled,
      autoGainEnabled,
      autoSensitivity,
      inputSensitivity,
      setInputMode,
      setPttKeyBinding,
      setMicProfile,
      setNoiseSuppression,
      setEchoCancellation,
      setAutoGain,
      setAutoSensitivity,
      setInputSensitivity,
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
      shareAudioActive,
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
      micProfile,
      krispReady,
      noiseSuppressionEnabled,
      echoCancellationEnabled,
      autoGainEnabled,
      autoSensitivity,
      inputSensitivity,
      setInputMode,
      setPttKeyBinding,
      setMicProfile,
      setNoiseSuppression,
      setEchoCancellation,
      setAutoGain,
      setAutoSensitivity,
      setInputSensitivity,
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
