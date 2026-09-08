import { type FormEvent, type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  ACCENT_COLORS,
  MUSIC_BOT_IDENTITY,
  parseParticipantMetadata,
  type AccentColor,
  type PublicConfig,
  type RoomSummary,
  type TextChannel,
  type UserSession,
  type VoiceChannel,
} from '@sausixudos/shared';
import {
  ConnectionState,
  LocalParticipant,
  RemoteParticipant,
  Track,
  type TrackPublication,
} from 'livekit-client';
import { AVATAR_DATA_URL_MAX_LENGTH, BANNER_DATA_URL_MAX_LENGTH } from '@sausixudos/shared';
import { api } from '../api';
import { useDelayedUnmount } from '../hooks/useDelayedUnmount';
import { type InputMode, type MicProfile, type ShareQuality, useVoiceRoom } from '../livekit/useVoiceRoom';
import { describeMediaError } from '../mediaAccess';
import { getPerfMode, type PerfMode, setPerfMode } from '../perfMode';
import { getDensity, type Density, setDensity } from '../density';
import { getTheme, type ThemeMode, setTheme } from '../theme';
import {
  CHAT_FONT_SCALES,
  getChatFontStep,
  getMessageSpacingStep,
  getOutputVolume,
  getUiAccent,
  getUiZoomStep,
  MESSAGE_SPACING_SCALES,
  setChatFontStep,
  setMessageSpacingStep,
  setOutputVolume,
  setUiAccent,
  setUiZoomStep,
  UI_ACCENT_SWATCHES,
  UI_ZOOM_SCALES,
} from '../appearancePrefs';
import {
  CameraIcon,
  CameraOffIcon,
  ChevronIcon,
  CloseIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  ImageIcon,
  LeaveIcon,
  MessageIcon,
  MicIcon,
  MicOffIcon,
  PaletteIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShareIcon,
  SpeakerIcon,
  UserIcon,
  VoiceIcon,
} from './Icons';
import { ProfilePopover, type ProfilePopoverTarget } from './ProfilePopover';
import { RemoteAudioSink } from './RemoteAudioSink';
import { ScreenStage } from './ScreenStage';
import { CreateTextChannelDialog, TextChannelView } from './TextChannels';

type MessageStyle = 'default' | 'compact' | 'grouped';
const MESSAGE_STYLE_KEY = 'gc:message-style';
const VALID_MESSAGE_STYLES: MessageStyle[] = ['default', 'compact', 'grouped'];

function loadMessageStyle(): MessageStyle {
  const stored = localStorage.getItem(MESSAGE_STYLE_KEY);
  return VALID_MESSAGE_STYLES.includes(stored as MessageStyle) ? (stored as MessageStyle) : 'default';
}

const THEME_OPTIONS: { value: ThemeMode; label: string; swatch: string }[] = [
  { value: 'claro', label: 'Claro', swatch: '#ffffff' },
  { value: 'ash', label: 'Ash', swatch: '#3c3f44' },
  { value: 'escuro', label: 'Escuro', swatch: '#313338' },
  { value: 'onyx', label: 'Onyx', swatch: '#000000' },
  { value: 'sistema', label: 'Sistema', swatch: 'linear-gradient(135deg, #ffffff 50%, #1e1f22 50%)' },
];

/** Redimensiona e recomprime uma imagem localmente até caber no limite de bytes, sem subir nenhum arquivo pro servidor separado — o resultado vira uma data: URL persistida junto do perfil. */
async function fileToResizedDataUrl(file: File, maxDimension: number, maxLength: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Não foi possível processar a imagem.');
  context.drawImage(bitmap, 0, 0, width, height);
  let quality = 0.88;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  while (dataUrl.length > maxLength && quality > 0.25) {
    quality -= 0.12;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  if (dataUrl.length > maxLength) throw new Error('Imagem muito grande mesmo após compressão.');
  return dataUrl;
}

interface WorkspaceProps {
  session: UserSession;
  config: PublicConfig;
  onSignOut: () => void | Promise<void>;
  onProfileUpdated: (session: UserSession) => void;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> };
};

declare global {
  interface Window {
    desktop?: {
      chooseShareSource: () => Promise<{ quality: ShareQuality; shareAudio: boolean } | null>;
      setZoomFactor: (factor: number) => void;
      setFullscreen: (enabled: boolean) => Promise<boolean>;
      getFullscreen: () => Promise<boolean>;
      onFullscreenChanged: (listener: (enabled: boolean) => void) => (() => void);
      getMediaAccessStatus: (mediaType: 'camera' | 'microphone') => Promise<'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'>;
      openMediaSettings: (mediaType: 'camera' | 'microphone') => Promise<boolean>;
    };
  }
}

function avatarLetter(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

function avatarColorIndex(name: string): number {
  const index = Array.from(name).reduce((value, character) => value + character.charCodeAt(0), 0);
  return index % ACCENT_COLORS.length;
}

export function Avatar({
  name,
  accentColor,
  avatarUrl,
  speaking = false,
  compact = false,
}: {
  name: string;
  accentColor?: AccentColor | undefined;
  avatarUrl?: string | undefined;
  speaking?: boolean;
  compact?: boolean;
}) {
  const colorIndex = accentColor ? ACCENT_COLORS.indexOf(accentColor) : avatarColorIndex(name);
  const className = `avatar ${avatarUrl ? '' : `avatar-color-${colorIndex}`} ${speaking ? 'speaking' : ''} ${compact ? 'compact' : ''}`;
  return (
    <span className={className}>
      {avatarUrl ? <img src={avatarUrl} alt={name} /> : avatarLetter(name)}
      <span className="presence-dot" />
    </span>
  );
}

const remoteAvatarCache = new Map<string, string>();

function useAvatarByIdentity(identity: string, isOwn: boolean, ownAvatarUrl: string): string | undefined {
  const [, forceRender] = useState(0);
  useEffect(() => {
    if (isOwn) return;
    if (remoteAvatarCache.has(identity)) return;
    let active = true;
    void api
      .getUserAvatar(identity)
      .then(({ avatarUrl }) => {
        if (!active) return;
        remoteAvatarCache.set(identity, avatarUrl);
        forceRender((value) => value + 1);
      })
      .catch(() => {
        if (active) remoteAvatarCache.set(identity, '');
      });
    return () => {
      active = false;
    };
  }, [identity, isOwn]);

  if (isOwn) return ownAvatarUrl || undefined;
  return remoteAvatarCache.get(identity) || undefined;
}

function useRemoteAvatar(participant: LocalParticipant | RemoteParticipant, ownAvatarUrl: string): string | undefined {
  return useAvatarByIdentity(participant.identity, participant instanceof LocalParticipant, ownAvatarUrl);
}

function ChannelUserAvatar({
  identity,
  name,
  ownIdentity,
  ownAvatarUrl,
}: {
  identity: string;
  name: string;
  ownIdentity: string;
  ownAvatarUrl: string;
}) {
  const avatarUrl = useAvatarByIdentity(identity, identity === ownIdentity, ownAvatarUrl);
  return <Avatar name={name} avatarUrl={avatarUrl} compact />;
}

function participantAccentColor(
  participant: LocalParticipant | RemoteParticipant,
  ownAccentColor: AccentColor,
): AccentColor | undefined {
  if (participant instanceof LocalParticipant) return ownAccentColor;
  const metadata = parseParticipantMetadata(participant.metadata);
  return metadata?.participantType === 'HUMAN' ? metadata.accentColor : undefined;
}

function DeviceMenu({
  devices,
  selectedId,
  onSelect,
  label,
}: {
  devices: MediaDeviceInfo[];
  selectedId: string;
  onSelect: (deviceId: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div className="device-menu" ref={containerRef}>
      <button type="button" className="device-menu-chevron" onClick={() => setOpen((value) => !value)} aria-label={label} title={label}>
        <ChevronIcon size={12} />
      </button>
      {open && (
        <div className="device-menu-popover">
          <button
            type="button"
            className={selectedId === 'default' ? 'active' : ''}
            onClick={() => {
              onSelect('default');
              setOpen(false);
            }}
          >
            Padrão do sistema
          </button>
          {devices.map((device) => (
            <button
              key={device.deviceId}
              type="button"
              className={selectedId === device.deviceId ? 'active' : ''}
              onClick={() => {
                onSelect(device.deviceId);
                setOpen(false);
              }}
            >
              {device.label || label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function IconSwap({ on, onIcon, offIcon }: { on: boolean; onIcon: ReactNode; offIcon: ReactNode }) {
  return (
    <span className="icon-swap">
      <span className={`icon-swap-layer ${on ? 'visible' : ''}`}>{onIcon}</span>
      <span className={`icon-swap-layer ${on ? '' : 'visible'}`}>{offIcon}</span>
    </span>
  );
}

function ChannelButton({
  channel,
  summary,
  active,
  loading,
  onClick,
  chatOpen,
  onToggleChat,
  ownIdentity,
  ownAvatarUrl,
  onOpenProfile,
}: {
  channel: VoiceChannel;
  summary: RoomSummary | undefined;
  active: boolean;
  loading: boolean;
  onClick: () => void;
  chatOpen: boolean;
  onToggleChat: () => void;
  ownIdentity: string;
  ownAvatarUrl: string;
  onOpenProfile: (userId: string, event: { currentTarget: HTMLElement }) => void;
}) {
  return (
    <div className="channel-block">
      <div className="channel-row">
        <button
          type="button"
          className={`channel-button ${active ? 'active' : ''}`}
          onClick={onClick}
          disabled={loading}
          title={channel.description}
          aria-busy={loading}
        >
          <VoiceIcon size={16} />
          <span>{channel.name}</span>
          <small>{loading ? '...' : summary?.participants.length || ''}</small>
        </button>
        {active && (
          <button
            type="button"
            className={`channel-chat-toggle ${chatOpen ? 'active' : ''}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleChat();
            }}
            title={chatOpen ? 'Fechar chat' : 'Abrir chat'}
            aria-label={chatOpen ? 'Fechar chat' : 'Abrir chat'}
          >
            <MessageIcon size={13} />
          </button>
        )}
      </div>
      {summary?.participants.map((participant) => {
        const isBot = participant.participantType === 'BOT';
        return (
          <button
            type="button"
            className="channel-user"
            key={participant.identity}
            disabled={isBot}
            onClick={(event) => {
              event.stopPropagation();
              onOpenProfile(participant.identity, event);
            }}
            title={isBot ? undefined : `Ver perfil de ${participant.name}`}
          >
            <ChannelUserAvatar
              identity={participant.identity}
              name={participant.name}
              ownIdentity={ownIdentity}
              ownAvatarUrl={ownAvatarUrl}
            />
            <span className="channel-user-name">{participant.name}</span>
            {isBot && <span className="bot-badge">BOT</span>}
            {participant.isSharingScreen && <span className="live-badge live-badge-inline">AO VIVO</span>}
          </button>
        );
      })}
    </div>
  );
}

function ParticipantRow({
  participant,
  speaking,
  volume,
  setVolume,
  accentColor,
  ownAvatarUrl,
  onOpenProfile,
}: {
  participant: LocalParticipant | RemoteParticipant;
  speaking: boolean;
  volume: number;
  setVolume: (value: number) => void;
  accentColor?: AccentColor | undefined;
  ownAvatarUrl: string;
  onOpenProfile: (userId: string, event: { currentTarget: HTMLElement }) => void;
}) {
  const name = participant.name || participant.identity;
  const local = participant instanceof LocalParticipant;
  const metadata = parseParticipantMetadata(participant.metadata);
  const isBot = metadata?.participantType === 'BOT';
  const avatarUrl = useRemoteAvatar(participant, ownAvatarUrl);
  const microphone = participant.getTrackPublication(Track.Source.Microphone);
  const muted = !microphone || microphone.isMuted;
  const isSharingScreen = Boolean(participant.getTrackPublication(Track.Source.ScreenShare));

  return (
    <div className={`participant-row ${speaking ? 'active-speaker' : ''}`}>
      <button
        type="button"
        className="participant-main"
        disabled={isBot}
        onClick={(event) => onOpenProfile(participant.identity, event)}
        title={isBot ? undefined : `Ver perfil de ${name}`}
      >
        <Avatar name={name} accentColor={accentColor} avatarUrl={avatarUrl} speaking={speaking} compact />
        <div className="participant-copy">
          <strong>
            {name}{local ? ' (você)' : ''}
            {isBot && <span className="bot-badge">BOT</span>}
            {isSharingScreen && <span className="live-badge" title="Compartilhando a tela">AO VIVO</span>}
          </strong>
          <span>{speaking ? (isBot ? 'Tocando' : 'Falando') : isBot ? 'Ocioso' : muted ? 'Microfone desligado' : 'Conectado'}</span>
        </div>
        {muted && <MicOffIcon className="participant-muted" size={14} />}
      </button>
      {!local && (
        <label className="volume-control" title={`Volume de ${name}: ${volume}%`}>
          <span>Vol.</span>
          <input
            aria-label={`Volume de ${name}`}
            type="range"
            min="0"
            max="100"
            value={volume}
            onChange={(event) => setVolume(Number(event.target.value))}
          />
          <output>{volume}</output>
        </label>
      )}
    </div>
  );
}

// Sempre montado enquanto conectado à voz, independente de qual canal (texto
// ou voz) está sendo exibido — antes o áudio ficava preso dentro do painel de
// membros da chamada, então trocar pra um canal de texto silenciava todo
// mundo até reconectar. Áudio não pode depender de qual tela está visível.
function VoiceAudioSinks({
  participants,
  volumes,
  streamVolumes,
  outputVolume,
  deafened,
}: {
  participants: (LocalParticipant | RemoteParticipant)[];
  volumes: Record<string, number>;
  streamVolumes: Record<string, number>;
  outputVolume: number;
  deafened: boolean;
}) {
  return (
    <>
      {participants
        .filter((participant): participant is RemoteParticipant => participant instanceof RemoteParticipant)
        .map((participant) => {
          const audioPublications = participant.audioTrackPublications as Map<string, TrackPublication>;
          const trackVersion = Array.from(audioPublications.values())
            .map((publication) => `${publication.trackSid}:${publication.isMuted}:${Boolean(publication.track)}`)
            .join('|');
          return (
            <RemoteAudioSink
              key={participant.identity}
              participant={participant}
              volume={volumes[participant.identity] ?? 100}
              streamVolume={streamVolumes[participant.identity] ?? 100}
              outputVolume={outputVolume}
              deafened={deafened}
              trackVersion={trackVersion}
            />
          );
        })}
    </>
  );
}

function RoomSkeleton() {
  return (
    <div className="room-loading" aria-label="Entrando na sala">
      <span>Entrando na sala...</span>
      <div className="skeleton-line wide" />
      <div className="skeleton-line" />
      <div className="skeleton-line short" />
    </div>
  );
}

type SettingsSection = 'profile' | 'voice' | 'appearance';

const MIC_METER_BARS = 20;

function MicTest({ deviceId }: { deviceId: string }) {
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef(0);

  function stopTest() {
    cancelAnimationFrame(frameRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void contextRef.current?.close();
    streamRef.current = null;
    contextRef.current = null;
    setTesting(false);
    setLevel(0);
  }

  useEffect(() => () => stopTest(), []);

  async function startTest() {
    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId === 'default' ? true : { deviceId: { exact: deviceId } },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      const audioContext = new AudioContext();
      contextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteFrequencyData(data);
        const average = data.reduce((sum, value) => sum + value, 0) / data.length;
        setLevel(Math.min(100, Math.round((average / 160) * 100)));
        frameRef.current = requestAnimationFrame(tick);
      };
      tick();
      setTesting(true);
    } catch {
      stopTest();
    }
  }

  const litBars = Math.round((level / 100) * MIC_METER_BARS);

  return (
    <div className="mic-test">
      <div className="mic-test-meter" aria-hidden="true">
        {Array.from({ length: MIC_METER_BARS }, (_, index) => (
          <span key={index} className={index < litBars ? 'lit' : ''} />
        ))}
      </div>
      <button type="button" className="test-toggle-button" onClick={() => (testing ? stopTest() : void startTest())}>
        {testing ? 'Parar teste' : 'Testar microfone'}
      </button>
    </div>
  );
}

function CameraPreview({ deviceId }: { deviceId: string }) {
  const [testing, setTesting] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  function stopPreview() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setTesting(false);
  }

  useEffect(() => () => stopPreview(), []);

  async function startPreview() {
    setPreviewError('');
    try {
      const constraints: MediaStreamConstraints = {
        video: deviceId === 'default' ? true : { deviceId: { exact: deviceId } },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setTesting(true);
    } catch (error) {
      stopPreview();
      setPreviewError(await describeMediaError(error, 'camera'));
    }
  }

  return (
    <div className="camera-preview">
      <div className="camera-preview-frame">
        <video ref={videoRef} autoPlay muted playsInline className={testing ? 'active' : ''} />
        {!testing && (
          <div className="camera-preview-placeholder">
            <CameraOffIcon size={22} />
          </div>
        )}
      </div>
      <button type="button" className="test-toggle-button" onClick={() => (testing ? stopPreview() : void startPreview())}>
        {testing ? 'Parar' : 'Testar vídeo'}
      </button>
      {previewError && (
        <div className="camera-permission-error" role="alert">
          <span>{previewError}</span>
          {window.desktop?.openMediaSettings && (
            <button type="button" onClick={() => void window.desktop?.openMediaSettings?.('camera')}>
              Abrir permissões
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SettingsModal({
  open,
  onClose,
  returnFocusRef,
  session,
  quality,
  setQuality,
  screenEnabled,
  perfMode,
  choosePerfMode,
  messageStyle,
  setMessageStyle,
  themeMode,
  chooseTheme,
  density,
  chooseDensity,
  chatFontStep,
  chooseChatFontStep,
  messageSpacingStep,
  chooseMessageSpacingStep,
  uiZoomStep,
  chooseUiZoomStep,
  uiAccent,
  chooseUiAccent,
  outputVolume,
  chooseOutputVolume,
  profileColor,
  setProfileColor,
  profileStatus,
  setProfileStatus,
  profileBio,
  setProfileBio,
  profilePronouns,
  setProfilePronouns,
  profileAvatar,
  setProfileAvatar,
  profileBanner,
  setProfileBanner,
  savingProfile,
  onSaveProfile,
  onCancelProfile,
  onSignOut,
  audioInputs,
  audioOutputs,
  videoInputs,
  selectedMicId,
  selectedSpeakerId,
  selectedCameraId,
  setMicrophoneDevice,
  setSpeakerDevice,
  setCameraDevice,
  refreshDevices,
  inputMode,
  setInputMode,
  pttKey,
  setPttKeyBinding,
  micProfile,
  setMicProfile,
  krispSupported,
  noiseSuppressionEnabled,
  setNoiseSuppression,
  echoCancellationEnabled,
  setEchoCancellation,
  autoGainEnabled,
  setAutoGain,
  autoSensitivity,
  setAutoSensitivity,
  inputSensitivity,
  setInputSensitivity,
}: {
  open: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  session: UserSession;
  quality: ShareQuality;
  setQuality: (quality: ShareQuality) => void;
  screenEnabled: boolean;
  perfMode: PerfMode;
  choosePerfMode: (mode: PerfMode) => void;
  messageStyle: MessageStyle;
  setMessageStyle: (style: MessageStyle) => void;
  themeMode: ThemeMode;
  chooseTheme: (mode: ThemeMode) => void;
  density: Density;
  chooseDensity: (value: Density) => void;
  chatFontStep: number;
  chooseChatFontStep: (step: number) => void;
  messageSpacingStep: number;
  chooseMessageSpacingStep: (step: number) => void;
  uiZoomStep: number;
  chooseUiZoomStep: (step: number) => void;
  uiAccent: { color: string; enabled: boolean };
  chooseUiAccent: (color: string, enabled: boolean) => void;
  outputVolume: number;
  chooseOutputVolume: (value: number) => void;
  profileColor: AccentColor;
  setProfileColor: (color: AccentColor) => void;
  profileStatus: string;
  setProfileStatus: (status: string) => void;
  profileBio: string;
  setProfileBio: (bio: string) => void;
  profilePronouns: string;
  setProfilePronouns: (pronouns: string) => void;
  profileAvatar: string;
  setProfileAvatar: (value: string) => void;
  profileBanner: string;
  setProfileBanner: (value: string) => void;
  savingProfile: boolean;
  onSaveProfile: () => void;
  onCancelProfile: () => void;
  onSignOut: () => void;
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
  selectedMicId: string;
  selectedSpeakerId: string;
  selectedCameraId: string;
  setMicrophoneDevice: (deviceId: string) => void;
  setSpeakerDevice: (deviceId: string) => void;
  setCameraDevice: (deviceId: string) => void;
  refreshDevices: () => void;
  inputMode: InputMode;
  setInputMode: (mode: InputMode) => void;
  pttKey: string;
  setPttKeyBinding: (code: string) => void;
  micProfile: MicProfile;
  setMicProfile: (profile: MicProfile) => void;
  krispSupported: boolean;
  noiseSuppressionEnabled: boolean;
  setNoiseSuppression: (enabled: boolean) => void;
  echoCancellationEnabled: boolean;
  setEchoCancellation: (enabled: boolean) => void;
  autoGainEnabled: boolean;
  setAutoGain: (enabled: boolean) => void;
  autoSensitivity: boolean;
  setAutoSensitivity: (enabled: boolean) => void;
  inputSensitivity: number;
  setInputSensitivity: (value: number) => void;
}) {
  const [listeningForKey, setListeningForKey] = useState(false);
  const [voiceSearch, setVoiceSearch] = useState('');
  const [avatarError, setAvatarError] = useState('');
  const [bannerError, setBannerError] = useState('');
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const firstNavigationButtonRef = useRef<HTMLButtonElement>(null);

  async function handleAvatarFile(file: File | undefined) {
    if (!file) return;
    setAvatarError('');
    try {
      setProfileAvatar(await fileToResizedDataUrl(file, 256, AVATAR_DATA_URL_MAX_LENGTH));
    } catch {
      setAvatarError('Não foi possível usar essa imagem. Tente um arquivo menor.');
    }
  }

  async function handleBannerFile(file: File | undefined) {
    if (!file) return;
    setBannerError('');
    try {
      setProfileBanner(await fileToResizedDataUrl(file, 960, BANNER_DATA_URL_MAX_LENGTH));
    } catch {
      setBannerError('Não foi possível usar essa imagem. Tente um arquivo menor.');
    }
  }

  const matchesSearch = (label: string) => voiceSearch.trim() === '' || label.toLowerCase().includes(voiceSearch.trim().toLowerCase());

  useEffect(() => {
    if (!listeningForKey) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      setPttKeyBinding(event.code);
      setListeningForKey(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [listeningForKey, setPttKeyBinding]);

  const [section, setSection] = useState<SettingsSection>('profile');
  const mounted = useDelayedUnmount(open, 200);

  useEffect(() => {
    if (open) refreshDevices();
  }, [open, refreshDevices]);

  useEffect(() => {
    if (!open || !mounted) return;
    firstNavigationButtonRef.current?.focus();
    const overlay = modalRef.current?.parentElement;
    const backgroundSiblings = Array.from(overlay?.parentElement?.children ?? [])
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay)
      .map((element) => ({ element, ariaHidden: element.getAttribute('aria-hidden') }));
    for (const { element } of backgroundSiblings) {
      element.setAttribute('inert', '');
      element.setAttribute('aria-hidden', 'true');
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
      for (const { element, ariaHidden } of backgroundSiblings) {
        element.removeAttribute('inert');
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      }
      window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    };
  }, [mounted, open, onClose, returnFocusRef]);

  if (!mounted) return null;

  return (
    <div className={`settings-overlay ${open ? 'entering' : 'leaving'}`} role="dialog" aria-modal="true" aria-label="Configurações">
      <div className="settings-modal" ref={modalRef}>
        <nav className="settings-nav">
          <span className="settings-nav-title">Configurações</span>
          <span className="settings-nav-group">Conta</span>
          <button ref={firstNavigationButtonRef} type="button" className={section === 'profile' ? 'active' : ''} onClick={() => setSection('profile')}>
            <UserIcon size={15} /> Meu perfil
          </button>
          <span className="settings-nav-group">Preferências</span>
          <button type="button" className={section === 'appearance' ? 'active' : ''} onClick={() => setSection('appearance')}>
            <PaletteIcon size={15} /> Aparência
          </button>
          <button type="button" className={section === 'voice' ? 'active' : ''} onClick={() => setSection('voice')}>
            <VoiceIcon size={15} /> Voz e vídeo
          </button>
          <span className="settings-nav-divider" />
          <button type="button" className="settings-nav-signout" onClick={onSignOut}>
            <LeaveIcon size={15} /> Sair da conta
          </button>
        </nav>

        <div className="settings-content">
          {section === 'profile' && (
            <div className="settings-pane two-column">
              <div className="settings-pane-main">
                <h2>Meu perfil</h2>
                <label className="settings-label">Banner do perfil</label>
                <div className="profile-banner-field">
                  {profileBanner && <img src={profileBanner} alt="" />}
                  <input
                    ref={bannerInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    hidden
                    onChange={(event) => void handleBannerFile(event.target.files?.[0])}
                  />
                  <button type="button" onClick={() => bannerInputRef.current?.click()}>
                    <ImageIcon size={13} /> Alterar banner
                  </button>
                </div>
                {bannerError && <p className="settings-hint">{bannerError}</p>}
                <p className="settings-hint">Recomendado: 1920×480. Máximo 800KB (redimensionado automaticamente). Formatos: PNG, JPG ou WEBP.</p>

                <div className="profile-avatar-field">
                  <Avatar name={session.displayName} accentColor={profileColor} avatarUrl={profileAvatar} />
                  <div className="profile-avatar-actions">
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      hidden
                      onChange={(event) => void handleAvatarFile(event.target.files?.[0])}
                    />
                    <button type="button" className="test-toggle-button" onClick={() => avatarInputRef.current?.click()}>
                      Alterar avatar
                    </button>
                    {profileAvatar && (
                      <button type="button" className="test-toggle-button" onClick={() => setProfileAvatar('')}>
                        Remover
                      </button>
                    )}
                  </div>
                </div>
                {avatarError && <p className="settings-hint">{avatarError}</p>}
                <p className="settings-hint">Recomendado: 512×512. Máximo 300KB (redimensionado automaticamente).</p>

                <label htmlFor="profile-status">Status<span className="field-char-count">{profileStatus.length}/60</span></label>
                <input
                  id="profile-status"
                  maxLength={60}
                  value={profileStatus}
                  onChange={(event) => setProfileStatus(event.target.value)}
                  placeholder="Seu status (opcional)"
                />
                <label htmlFor="profile-pronouns">Pronomes<span className="field-char-count">{profilePronouns.length}/30</span></label>
                <input
                  id="profile-pronouns"
                  maxLength={30}
                  value={profilePronouns}
                  onChange={(event) => setProfilePronouns(event.target.value)}
                  placeholder="ex.: ele/dele, ela/dela (opcional)"
                />
                <label htmlFor="profile-bio">Sobre mim<span className="field-char-count">{profileBio.length}/300</span></label>
                <textarea
                  id="profile-bio"
                  className="profile-bio-input"
                  maxLength={300}
                  value={profileBio}
                  onChange={(event) => setProfileBio(event.target.value)}
                  placeholder="Conte um pouco sobre você (opcional)"
                  rows={3}
                />
                <label htmlFor="accent-color-modal">Cor do perfil</label>
                <div className="accent-picker" id="accent-color-modal" role="radiogroup" aria-label="Cor do perfil">
                  {ACCENT_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      role="radio"
                      aria-checked={profileColor === color}
                      aria-label={`Cor ${color}`}
                      className={`accent-swatch ${profileColor === color ? 'selected' : ''}`}
                      data-color={color}
                      onClick={() => setProfileColor(color)}
                    />
                  ))}
                </div>
                <div className="profile-form-actions">
                  <button className="test-toggle-button" type="button" onClick={onCancelProfile} disabled={savingProfile}>
                    Cancelar
                  </button>
                  <button className="save-profile-button" type="button" disabled={savingProfile} onClick={onSaveProfile}>
                    {savingProfile ? 'Salvando…' : 'Salvar alterações'}
                  </button>
                </div>
              </div>
              <div className="settings-pane-side">
                <span className="settings-side-title">Pré-visualização</span>
                <div className="profile-preview">
                  {profileBanner ? (
                    <img className="profile-preview-banner has-image" src={profileBanner} alt="" />
                  ) : (
                    <div className={`profile-preview-banner avatar-color-${ACCENT_COLORS.indexOf(profileColor)}`} />
                  )}
                  <Avatar name={session.displayName} accentColor={profileColor} avatarUrl={profileAvatar} />
                  <strong>{session.displayName}</strong>
                  {profilePronouns && <em>{profilePronouns}</em>}
                  {profileStatus && <span>{profileStatus}</span>}
                  {profileBio && <p>{profileBio}</p>}
                </div>
              </div>
            </div>
          )}

          {section === 'voice' && (
            <div className="settings-pane two-column">
              <div className="settings-pane-main">
                <div className="settings-pane-heading-row">
                  <h2>Voz e vídeo</h2>
                  <label className="settings-search" aria-label="Buscar nas configurações">
                    <SearchIcon size={14} />
                    <input
                      type="text"
                      placeholder="Buscar nas configurações"
                      value={voiceSearch}
                      onChange={(event) => setVoiceSearch(event.target.value)}
                    />
                  </label>
                </div>

                {(matchesSearch('dispositivo de entrada') || matchesSearch('dispositivo de saída') || matchesSearch('volume')) && (
                  <div className="settings-field-row">
                    {matchesSearch('dispositivo de entrada') && (
                      <div>
                        <label htmlFor="mic-device">Dispositivo de entrada</label>
                        <select id="mic-device" value={selectedMicId} onChange={(event) => setMicrophoneDevice(event.target.value)}>
                          <option value="default">Padrão do sistema</option>
                          {audioInputs.map((device) => (
                            <option key={device.deviceId} value={device.deviceId}>
                              {device.label || 'Microfone'}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {matchesSearch('dispositivo de saída') && (
                      <div>
                        <label htmlFor="speaker-device">Dispositivo de saída</label>
                        <select id="speaker-device" value={selectedSpeakerId} onChange={(event) => setSpeakerDevice(event.target.value)}>
                          <option value="default">Padrão do sistema</option>
                          {audioOutputs.map((device) => (
                            <option key={device.deviceId} value={device.deviceId}>
                              {device.label || 'Saída de áudio'}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {matchesSearch('volume de saída') && (
                      <div>
                        <label htmlFor="output-volume">Volume de saída</label>
                        <div className="pref-slider-row">
                          <input
                            id="output-volume"
                            type="range"
                            min={0}
                            max={100}
                            value={outputVolume}
                            onChange={(event) => chooseOutputVolume(Number(event.target.value))}
                          />
                          <output>{outputVolume}%</output>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {matchesSearch('teste de microfone') && (
                  <>
                    <span className="settings-label">Teste de microfone</span>
                    <MicTest deviceId={selectedMicId} />
                  </>
                )}

                {matchesSearch('perfil de entrada isolamento de voz estúdio personalizado') && (
                  <>
                    <span className="settings-label">Perfil de entrada</span>
                    <div className="input-mode-cards mic-profile-cards" role="group" aria-label="Perfil de entrada de microfone">
                      <button type="button" className={`input-mode-card ${micProfile === 'isolamento' ? 'active' : ''}`} onClick={() => setMicProfile('isolamento')}>
                        <MicIcon size={18} />
                        <strong>Isolamento de Voz</strong>
                        <span>
                          {krispSupported
                            ? 'Só a sua voz: roda o Krisp (o mesmo motor de IA do Discord) localmente pra remover ruído de fundo de verdade.'
                            : 'Só a sua voz: seu navegador não suporta o motor de IA, então usamos a supressão nativa dele como alternativa.'}
                        </span>
                      </button>
                      <button type="button" className={`input-mode-card ${micProfile === 'estudio' ? 'active' : ''}`} onClick={() => setMicProfile('estudio')}>
                        <SpeakerIcon size={18} />
                        <strong>Estúdio</strong>
                        <span>Áudio puro: microfone aberto, sem nenhum processamento.</span>
                      </button>
                      <button type="button" className={`input-mode-card ${micProfile === 'personalizado' ? 'active' : ''}`} onClick={() => setMicProfile('personalizado')}>
                        <SettingsIcon size={18} />
                        <strong>Personalizado</strong>
                        <span>Modo avançado: escolha cada opção de processamento manualmente.</span>
                      </button>
                    </div>
                  </>
                )}

                {micProfile === 'personalizado' && matchesSearch('supressão de ruído cancelamento de eco ganho automático sensibilidade de entrada') && (
                  <div className="mic-profile-advanced">
                    <div className="settings-toggle-row voice-processing-toggle">
                      <div>
                        <span className="settings-label">Supressão de ruído</span>
                        <p className="settings-hint">
                          {krispSupported
                            ? 'Krisp de verdade rodando localmente (mesmo motor de IA do Discord) — reduz ventilador, teclado, cliques e ruído de fundo constante.'
                            : 'Seu navegador não suporta o motor de IA do Krisp; isso liga a supressão nativa dele como alternativa, mais fraca contra ruídos como teclado.'}
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-label="Supressão de ruído"
                        aria-checked={noiseSuppressionEnabled}
                        className={`settings-switch ${noiseSuppressionEnabled ? 'on' : ''}`}
                        onClick={() => setNoiseSuppression(!noiseSuppressionEnabled)}
                      />
                    </div>
                    <div className="settings-toggle-row voice-processing-toggle">
                      <div>
                        <span className="settings-label">Cancelamento de eco</span>
                        <p className="settings-hint">Evita que o som dos seus alto-falantes volte pelo microfone.</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-label="Cancelamento de eco"
                        aria-checked={echoCancellationEnabled}
                        className={`settings-switch ${echoCancellationEnabled ? 'on' : ''}`}
                        onClick={() => setEchoCancellation(!echoCancellationEnabled)}
                      />
                    </div>
                    <div className="settings-toggle-row voice-processing-toggle">
                      <div>
                        <span className="settings-label">Controle automático de ganho</span>
                        <p className="settings-hint">Ajusta o volume de entrada automaticamente pra manter a fala num nível constante.</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-label="Controle automático de ganho"
                        aria-checked={autoGainEnabled}
                        className={`settings-switch ${autoGainEnabled ? 'on' : ''}`}
                        onClick={() => setAutoGain(!autoGainEnabled)}
                      />
                    </div>

                    <div className="settings-toggle-row voice-processing-toggle">
                      <div>
                        <span className="settings-label">Ajustar automaticamente a sensibilidade de entrada</span>
                        <p className="settings-hint">Em modo Voz ativa, o microfone só transmite quando você está falando de verdade — calibra sozinho o ruído de fundo ao entrar na chamada.</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-label="Ajustar automaticamente a sensibilidade de entrada"
                        aria-checked={autoSensitivity}
                        className={`settings-switch ${autoSensitivity ? 'on' : ''}`}
                        onClick={() => setAutoSensitivity(!autoSensitivity)}
                      />
                    </div>
                    {!autoSensitivity && (
                      <div>
                        <label htmlFor="input-sensitivity">Sensibilidade de entrada (manual)</label>
                        <div className="pref-slider-row">
                          <input
                            id="input-sensitivity"
                            type="range"
                            min={0}
                            max={100}
                            value={inputSensitivity}
                            onChange={(event) => setInputSensitivity(Number(event.target.value))}
                          />
                          <output>{inputSensitivity}%</output>
                        </div>
                        <p className="settings-hint">Quanto maior, mais alto você precisa falar pra o microfone ligar. Use o teste de microfone acima pra calibrar.</p>
                      </div>
                    )}
                    {inputMode !== 'voice' && (
                      <p className="settings-hint">A sensibilidade de entrada só se aplica no modo Voz ativa — em Push to talk, a tecla já controla isso.</p>
                    )}
                  </div>
                )}

                {matchesSearch('modo de entrada') && (
                  <>
                    <span className="settings-label">Modo de entrada</span>
                    <div className="input-mode-cards" role="group" aria-label="Modo de entrada de voz">
                      <button type="button" className={`input-mode-card ${inputMode === 'voice' ? 'active' : ''}`} onClick={() => setInputMode('voice')}>
                        <MicIcon size={18} />
                        <strong>Voz ativa</strong>
                        <span>O microfone é ativado automaticamente quando você fala.</span>
                      </button>
                      <button type="button" className={`input-mode-card ${inputMode === 'ptt' ? 'active' : ''}`} onClick={() => setInputMode('ptt')}>
                        <MicOffIcon size={18} />
                        <strong>Push to talk</strong>
                        <span>O microfone só é ativado quando você pressiona uma tecla.</span>
                      </button>
                    </div>
                    {inputMode === 'ptt' && (
                      <>
                        <label htmlFor="ptt-key">Tecla de push-to-talk</label>
                        <button
                          id="ptt-key"
                          type="button"
                          className="ptt-key-button"
                          onClick={() => setListeningForKey(true)}
                        >
                          {listeningForKey ? 'Pressione uma tecla…' : pttKey}
                        </button>
                      </>
                    )}
                  </>
                )}

                {matchesSearch('qualidade da transmissão de tela') && (
                  <>
                    <label htmlFor="share-quality">Qualidade da transmissão de tela</label>
                    <select
                      id="share-quality"
                      value={quality}
                      onChange={(event) => setQuality(event.target.value as ShareQuality)}
                      disabled={screenEnabled}
                    >
                      <option value="720p30">720p · 30 FPS</option>
                      <option value="720p60">720p · 60 FPS</option>
                      <option value="1080p60">1080p · 60 FPS</option>
                    </select>
                  </>
                )}
              </div>
              <div className="settings-pane-side">
                {matchesSearch('câmera') && (
                  <>
                    <span className="settings-side-title">Câmera</span>
                    <select id="camera-device" value={selectedCameraId} onChange={(event) => setCameraDevice(event.target.value)}>
                      <option value="default">Padrão do sistema</option>
                      {videoInputs.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || 'Câmera'}
                        </option>
                      ))}
                    </select>
                    <CameraPreview deviceId={selectedCameraId} />
                  </>
                )}
              </div>
            </div>
          )}

          {section === 'appearance' && (
            <div className="settings-pane two-column">
              <div className="settings-pane-main">
                <h2>Aparência</h2>

                <span className="settings-label">Tema</span>
                <div className="theme-cards" role="group" aria-label="Tema">
                  {THEME_OPTIONS.map((theme) => (
                    <button
                      key={theme.value}
                      type="button"
                      className={`theme-card ${themeMode === theme.value ? 'active' : ''}`}
                      onClick={() => chooseTheme(theme.value)}
                    >
                      <span className="theme-card-swatch" style={{ background: theme.swatch }} />
                      <span>{theme.label}</span>
                    </button>
                  ))}
                </div>

                <span className="settings-label">Modo de desempenho</span>
                <div className="perf-toggle" role="group" aria-label="Modo de desempenho">
                  <button type="button" className={perfMode === 'full' ? 'active' : ''} onClick={() => choosePerfMode('full')}>
                    Completo
                  </button>
                  <button type="button" className={perfMode === 'lite' ? 'active' : ''} onClick={() => choosePerfMode('lite')}>
                    Leve
                  </button>
                </div>
                <p className="settings-hint">
                  O modo leve desliga animações e efeitos visuais para PCs mais fracos.
                </p>

                <span className="settings-label">Densidade da interface</span>
                <div className="perf-toggle three-way" role="group" aria-label="Densidade da interface">
                  <button type="button" className={density === 'compacta' ? 'active' : ''} onClick={() => chooseDensity('compacta')}>
                    Compacta
                  </button>
                  <button type="button" className={density === 'padrao' ? 'active' : ''} onClick={() => chooseDensity('padrao')}>
                    Padrão
                  </button>
                  <button type="button" className={density === 'confortavel' ? 'active' : ''} onClick={() => chooseDensity('confortavel')}>
                    Confortável
                  </button>
                </div>

                <span className="settings-label">Estilo de exibição das mensagens</span>
                <div className="perf-toggle three-way" role="group" aria-label="Estilo de exibição das mensagens">
                  <button type="button" className={messageStyle === 'default' ? 'active' : ''} onClick={() => setMessageStyle('default')}>
                    Padrão
                  </button>
                  <button type="button" className={messageStyle === 'compact' ? 'active' : ''} onClick={() => setMessageStyle('compact')}>
                    Compacto
                  </button>
                  <button type="button" className={messageStyle === 'grouped' ? 'active' : ''} onClick={() => setMessageStyle('grouped')}>
                    Agrupado
                  </button>
                </div>

                <label htmlFor="chat-font-slider">Tamanho da fonte do chat</label>
                <div className="pref-slider-row">
                  <input
                    id="chat-font-slider"
                    type="range"
                    min={0}
                    max={CHAT_FONT_SCALES.length - 1}
                    value={chatFontStep}
                    onChange={(event) => chooseChatFontStep(Number(event.target.value))}
                  />
                  <output>{CHAT_FONT_SCALES[chatFontStep]}%</output>
                </div>

                <label htmlFor="message-spacing-slider">Espaçamento entre mensagens</label>
                <div className="pref-slider-row">
                  <input
                    id="message-spacing-slider"
                    type="range"
                    min={0}
                    max={MESSAGE_SPACING_SCALES.length - 1}
                    value={messageSpacingStep}
                    onChange={(event) => chooseMessageSpacingStep(Number(event.target.value))}
                  />
                  <output>{MESSAGE_SPACING_SCALES[messageSpacingStep]}%</output>
                </div>

                <label htmlFor="ui-zoom-slider">Zoom da interface</label>
                <div className="pref-slider-row">
                  <input
                    id="ui-zoom-slider"
                    type="range"
                    min={0}
                    max={UI_ZOOM_SCALES.length - 1}
                    value={uiZoomStep}
                    onChange={(event) => chooseUiZoomStep(Number(event.target.value))}
                  />
                  <output>{UI_ZOOM_SCALES[uiZoomStep]}%</output>
                </div>
              </div>
              <div className="settings-pane-side">
                <span className="settings-side-title">Pré-visualização</span>
                <div className="appearance-preview">
                  <div className={`messages ${messageStyle === 'compact' ? 'compact' : ''} ${messageStyle === 'grouped' ? 'grouped' : ''}`}>
                    <article className="message">
                      <Avatar name={session.displayName} accentColor={profileColor} avatarUrl={profileAvatar} compact />
                      <div>
                        <header>
                          <strong>{session.displayName}</strong>
                          <time>14:28</time>
                        </header>
                        <p>E aí, tudo certo?</p>
                      </div>
                    </article>
                    <article className="message">
                      <Avatar name="Amigo" compact />
                      <div>
                        <header>
                          <strong>Amigo</strong>
                          <time>14:29</time>
                        </header>
                        <p>Essa aparência nova tá ótima!</p>
                      </div>
                    </article>
                  </div>
                </div>

                <span className="settings-side-title">Cores e personalização</span>
                <div className="ui-accent-row">
                  <div className="accent-picker">
                    {UI_ACCENT_SWATCHES.map((color) => (
                      <button
                        key={color}
                        type="button"
                        role="radio"
                        aria-checked={uiAccent.enabled && uiAccent.color === color}
                        aria-label={`Cor ${color}`}
                        className={`accent-swatch ${uiAccent.enabled && uiAccent.color === color ? 'selected' : ''}`}
                        data-color={color}
                        onClick={() => chooseUiAccent(color, true)}
                      />
                    ))}
                  </div>
                  <div className="ui-accent-hex">
                    <input
                      type="color"
                      value={uiAccent.color}
                      onChange={(event) => chooseUiAccent(event.target.value, true)}
                      aria-label="Cor personalizada"
                    />
                    <input
                      type="text"
                      value={uiAccent.color}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (/^#[0-9a-fA-F]{6}$/.test(value)) chooseUiAccent(value, true);
                      }}
                    />
                  </div>
                </div>
                <div className="settings-toggle-row">
                  <span>Aplicar cor nos elementos da interface</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={uiAccent.enabled}
                    className={`settings-switch ${uiAccent.enabled ? 'on' : ''}`}
                    onClick={() => chooseUiAccent(uiAccent.color, !uiAccent.enabled)}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="settings-close-group">
          <button className="settings-close" type="button" onClick={onClose} aria-label="Fechar configurações">
            <CloseIcon size={20} />
          </button>
          <span>ESC</span>
        </div>
      </div>
    </div>
  );
}

export function Workspace({ session, config, onSignOut, onProfileUpdated }: WorkspaceProps) {
  const voice = useVoiceRoom();
  const [rooms, setRooms] = useState<RoomSummary[]>(config.channels.map((channel) => ({ ...channel, participants: [] })));
  const [livekitAvailable, setLivekitAvailable] = useState(true);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [quality, setQuality] = useState<ShareQuality>('1080p60');
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [streamVolumes, setStreamVolumes] = useState<Record<string, number>>({});
  const [watchingScreenIds, setWatchingScreenIds] = useState<Set<string>>(new Set());
  // restrictOwnAudio (na captura de áudio da transmissão, useVoiceRoom.ts) já
  // pede pro Chromium excluir o áudio do nosso próprio app do que é capturado
  // por loopback — isso deveria impedir a voz de qualquer um na call (a sua
  // inclusive) de vazar de volta pela transmissão de quem compartilha, sem
  // precisar mutar ninguém localmente. Mantemos esse toggle como válvula de
  // escape manual só caso o filtro do navegador não elimine 100% do vazamento
  // em algum ambiente.
  const [allowListenWhileSharing, setAllowListenWhileSharing] = useState(true);
  const [chatText, setChatText] = useState('');
  const [profileTarget, setProfileTarget] = useState<ProfilePopoverTarget | null>(null);
  const openUserProfile = (userId: string, event: { currentTarget: HTMLElement }) =>
    setProfileTarget({ userId, rect: event.currentTarget.getBoundingClientRect() });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [textChannels, setTextChannels] = useState<TextChannel[]>([]);
  const [selectedTextChannelId, setSelectedTextChannelId] = useState<string | null>(null);
  const [createTextChannelOpen, setCreateTextChannelOpen] = useState(false);
  const [perfMode, setPerfModeState] = useState<PerfMode>(() => getPerfMode());
  const [messageStyle, setMessageStyleState] = useState<MessageStyle>(() => loadMessageStyle());
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => getTheme());
  const [density, setDensityState] = useState<Density>(() => getDensity());
  const [chatFontStep, setChatFontStepState] = useState(() => getChatFontStep());
  const [messageSpacingStep, setMessageSpacingStepState] = useState(() => getMessageSpacingStep());
  const [uiZoomStep, setUiZoomStepState] = useState(() => getUiZoomStep());
  const [uiAccent, setUiAccentState] = useState(() => getUiAccent());
  const [outputVolume, setOutputVolumeState] = useState(() => getOutputVolume());
  const [profileColor, setProfileColor] = useState<AccentColor>(session.accentColor);
  const [profileStatus, setProfileStatus] = useState(session.statusText);
  const [profileBio, setProfileBio] = useState(session.bio);
  const [profilePronouns, setProfilePronouns] = useState(session.pronouns);
  const [profileAvatar, setProfileAvatar] = useState(session.avatarUrl);
  const [profileBanner, setProfileBanner] = useState(session.bannerUrl);
  const [savingProfile, setSavingProfile] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const createTextChannelButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const textChannelsInitializedRef = useRef(false);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeCreateTextChannel = useCallback(() => setCreateTextChannelOpen(false), []);

  function choosePerfMode(mode: PerfMode) {
    setPerfMode(mode);
    setPerfModeState(mode);
  }

  function setMessageStyle(style: MessageStyle) {
    localStorage.setItem(MESSAGE_STYLE_KEY, style);
    setMessageStyleState(style);
  }

  function chooseTheme(mode: ThemeMode) {
    setTheme(mode);
    setThemeModeState(mode);
  }

  function chooseDensity(value: Density) {
    setDensity(value);
    setDensityState(value);
  }

  function chooseChatFontStep(step: number) {
    setChatFontStep(step);
    setChatFontStepState(step);
  }

  function chooseMessageSpacingStep(step: number) {
    setMessageSpacingStep(step);
    setMessageSpacingStepState(step);
  }

  function chooseUiZoomStep(step: number) {
    setUiZoomStep(step);
    setUiZoomStepState(step);
  }

  function chooseUiAccent(color: string, enabled: boolean) {
    setUiAccent(color, enabled);
    setUiAccentState({ color, enabled });
  }

  function chooseOutputVolume(value: number) {
    setOutputVolume(value);
    setOutputVolumeState(value);
  }

  function resetProfileDraft() {
    setProfileColor(session.accentColor);
    setProfileStatus(session.statusText);
    setProfileBio(session.bio);
    setProfilePronouns(session.pronouns);
    setProfileAvatar(session.avatarUrl);
    setProfileBanner(session.bannerUrl);
  }

  async function saveProfile() {
    setSavingProfile(true);
    try {
      const { user } = await api.updateProfile(
        profileColor,
        profileStatus,
        profileBio,
        profilePronouns,
        profileAvatar,
        profileBanner,
      );
      onProfileUpdated(user);
    } catch {
      // O usuário pode tentar novamente pelo mesmo popover.
    } finally {
      setSavingProfile(false);
    }
  }

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void api.getRooms().then((result) => {
        if (!active) return;
        setRooms(result.rooms);
        setLivekitAvailable(result.livekitAvailable);
      }).catch(() => active && setLivekitAvailable(false));
    };
    refresh();
    const timer = window.setInterval(refresh, 4_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void api.getTextChannels().then(({ channels }) => {
        if (!active) return;
        setTextChannels(channels);
        if (!textChannelsInitializedRef.current) {
          textChannelsInitializedRef.current = true;
          setSelectedTextChannelId(channels[0]?.id ?? null);
        } else {
          setSelectedTextChannelId((current) => {
            if (current && !channels.some(({ id }) => id === current)) return channels[0]?.id ?? null;
            return current;
          });
        }
      }).catch(() => {
        // Mantém a última lista disponível e tenta novamente no próximo intervalo.
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [voice.messages]);

  const connectionLabel = useMemo(() => {
    switch (voice.connectionState) {
      case ConnectionState.Connected: return 'Conectado';
      case ConnectionState.Connecting: return 'Conectando';
      case ConnectionState.Reconnecting: return 'Reconectando';
      default: return 'Desconectado';
    }
  }, [voice.connectionState]);

  async function startOrStopScreenShare() {
    if (voice.screenEnabled) {
      await voice.toggleScreenShare(quality);
      return;
    }
    if (!window.desktop) {
      // Fora do app empacotado (ex.: navegador comum durante o desenvolvimento)
      // não existe picker nativo — cai no fluxo antigo com a qualidade já
      // escolhida em Configurações.
      await voice.toggleScreenShare(quality);
      return;
    }
    const choice = await window.desktop.chooseShareSource();
    if (!choice) return;
    setQuality(choice.quality);
    await voice.toggleScreenShare(choice.quality, choice.shareAudio);
  }

  async function joinChannel(channel: VoiceChannel) {
    setSelectedTextChannelId(null);
    const startViewTransition = (document as ViewTransitionDocument).startViewTransition?.bind(document);
    if (perfMode === 'full' && startViewTransition) {
      startViewTransition(() => flushSync(() => setJoiningId(channel.id)));
    } else {
      setJoiningId(channel.id);
    }
    await voice.connect(channel);
    setJoiningId(null);
  }

  function handleTextChannelCreated(channel: TextChannel) {
    setTextChannels((current) => current.some(({ id }) => id === channel.id) ? current : [...current, channel]);
    setSelectedTextChannelId(channel.id);
  }

  async function submitChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    try {
      await voice.sendMessage(chatText);
      setChatText('');
    } catch {
      // O estado da conexão informa quando o envio está indisponível.
    }
  }

  function renderParticipantRow(participant: LocalParticipant | RemoteParticipant) {
    return (
      <ParticipantRow
        key={participant.identity}
        participant={participant}
        speaking={voice.speakers.has(participant.identity)}
        volume={volumes[participant.identity] ?? 100}
        setVolume={(value) => setVolumes((current) => ({ ...current, [participant.identity]: value }))}
        accentColor={participantAccentColor(participant, session.accentColor)}
        ownAvatarUrl={session.avatarUrl}
        onOpenProfile={openUserProfile}
      />
    );
  }

  const typedParticipants = voice.participants as (LocalParticipant | RemoteParticipant)[];
  const activeTextChannel = textChannels.find(({ id }) => id === selectedTextChannelId);

  return (
    <main className="workspace">
      <SettingsModal
        open={settingsOpen}
        onClose={closeSettings}
        returnFocusRef={settingsButtonRef}
        session={session}
        quality={quality}
        setQuality={setQuality}
        screenEnabled={voice.screenEnabled}
        perfMode={perfMode}
        choosePerfMode={choosePerfMode}
        messageStyle={messageStyle}
        setMessageStyle={setMessageStyle}
        themeMode={themeMode}
        chooseTheme={chooseTheme}
        density={density}
        chooseDensity={chooseDensity}
        chatFontStep={chatFontStep}
        chooseChatFontStep={chooseChatFontStep}
        messageSpacingStep={messageSpacingStep}
        chooseMessageSpacingStep={chooseMessageSpacingStep}
        uiZoomStep={uiZoomStep}
        chooseUiZoomStep={chooseUiZoomStep}
        uiAccent={uiAccent}
        chooseUiAccent={chooseUiAccent}
        outputVolume={outputVolume}
        chooseOutputVolume={chooseOutputVolume}
        profileColor={profileColor}
        setProfileColor={setProfileColor}
        profileStatus={profileStatus}
        setProfileStatus={setProfileStatus}
        profileBio={profileBio}
        setProfileBio={setProfileBio}
        profilePronouns={profilePronouns}
        setProfilePronouns={setProfilePronouns}
        profileAvatar={profileAvatar}
        setProfileAvatar={setProfileAvatar}
        profileBanner={profileBanner}
        setProfileBanner={setProfileBanner}
        savingProfile={savingProfile}
        onSaveProfile={() => void saveProfile()}
        onCancelProfile={resetProfileDraft}
        onSignOut={() => void voice.disconnect().finally(onSignOut)}
        micProfile={voice.micProfile}
        krispSupported={voice.krispSupported}
        setMicProfile={voice.setMicProfile}
        echoCancellationEnabled={voice.echoCancellationEnabled}
        setEchoCancellation={voice.setEchoCancellation}
        autoGainEnabled={voice.autoGainEnabled}
        setAutoGain={voice.setAutoGain}
        autoSensitivity={voice.autoSensitivity}
        setAutoSensitivity={voice.setAutoSensitivity}
        inputSensitivity={voice.inputSensitivity}
        setInputSensitivity={voice.setInputSensitivity}
        audioInputs={voice.audioInputs}
        audioOutputs={voice.audioOutputs}
        videoInputs={voice.videoInputs}
        selectedMicId={voice.selectedMicId}
        selectedSpeakerId={voice.selectedSpeakerId}
        selectedCameraId={voice.selectedCameraId}
        setMicrophoneDevice={(deviceId) => void voice.setMicrophoneDevice(deviceId)}
        setSpeakerDevice={(deviceId) => void voice.setSpeakerDevice(deviceId)}
        setCameraDevice={(deviceId) => void voice.setCameraDevice(deviceId)}
        refreshDevices={() => void voice.refreshDevices()}
        inputMode={voice.inputMode}
        setInputMode={voice.setInputMode}
        pttKey={voice.pttKey}
        setPttKeyBinding={voice.setPttKeyBinding}
        noiseSuppressionEnabled={voice.noiseSuppressionEnabled}
        setNoiseSuppression={(enabled) => void voice.setNoiseSuppression(enabled)}
      />
      <CreateTextChannelDialog
        open={createTextChannelOpen}
        onClose={closeCreateTextChannel}
        onCreated={handleTextChannelCreated}
        returnFocusRef={createTextChannelButtonRef}
      />
      {voice.connected && (
        <VoiceAudioSinks
          participants={typedParticipants}
          volumes={volumes}
          streamVolumes={streamVolumes}
          outputVolume={outputVolume}
          deafened={voice.deafened || (voice.shareAudioActive && !allowListenWhileSharing)}
        />
      )}
      <ProfilePopover target={profileTarget} ownSession={session} onClose={() => setProfileTarget(null)} />
      <aside className="server-rail" aria-label="Servidores">
        <button className="server-button home active" type="button" title="Sausixudos" aria-label="Sausixudos">S</button>
        <span className="rail-divider" />
        <button className="server-button add" type="button" title="Adicionar servidor" aria-label="Adicionar servidor" disabled>
          <PlusIcon size={18} />
        </button>
      </aside>

      <aside className="sidebar">
        <header className="sidebar-header">
          <strong>Lobby dos amigos</strong>
          <ChevronIcon size={16} />
        </header>

        <nav className="channels" aria-label="Canais do servidor">
          <div className="section-title">
            <span>CANAIS DE TEXTO</span>
            <button
              ref={createTextChannelButtonRef}
              type="button"
              className="add-channel-button"
              onClick={() => setCreateTextChannelOpen(true)}
              aria-label="Criar canal de texto"
              title="Criar canal de texto"
            >
              <PlusIcon size={14} />
            </button>
          </div>
          <div className="text-channel-list">
            {textChannels.map((channel) => {
              const selected = channel.id === selectedTextChannelId;
              return (
                <button
                  key={channel.id}
                  type="button"
                  className={`text-channel-button ${selected ? 'active' : ''}`}
                  onClick={() => setSelectedTextChannelId(channel.id)}
                  aria-current={selected ? 'page' : undefined}
                  title={channel.description}
                >
                  <span className="channel-hash" aria-hidden="true">#</span>
                  <span>{channel.name}</span>
                </button>
              );
            })}
          </div>
          <div className="section-title">
            <span>CANAIS DE VOZ</span>
            <small>{rooms.reduce((sum, room) => sum + room.participants.length, 0)} online</small>
          </div>
          {!livekitAvailable && <div className="service-warning">LiveKit indisponível</div>}
          {config.channels.map((channel) => (
            <ChannelButton
              key={channel.id}
              channel={channel}
              summary={rooms.find((room) => room.id === channel.id)}
              active={voice.currentChannel?.id === channel.id && voice.connected}
              loading={joiningId === channel.id}
              onClick={() => void joinChannel(channel)}
              chatOpen={chatOpen}
              onToggleChat={() => setChatOpen((open) => !open)}
              ownIdentity={session.id}
              ownAvatarUrl={session.avatarUrl}
              onOpenProfile={openUserProfile}
            />
          ))}
        </nav>

        {voice.connected && (
          <div className="voice-status-panel">
            <div className="voice-status-info">
              <span className="voice-status-dot" />
              <div>
                <strong>Voz conectada</strong>
                <span>{voice.currentChannel?.name} / Lobby dos amigos</span>
              </div>
            </div>
            <div className="voice-status-actions">
              <button
                type="button"
                className={`icon-button small ${voice.cameraEnabled ? 'selected' : ''}`}
                onClick={() => void voice.toggleCamera()}
                title={voice.cameraEnabled ? 'Desligar câmera' : 'Ligar câmera'}
                aria-label={voice.cameraEnabled ? 'Desligar câmera' : 'Ligar câmera'}
              >
                <IconSwap on={voice.cameraEnabled} onIcon={<CameraIcon size={15} />} offIcon={<CameraOffIcon size={15} />} />
              </button>
              <button
                type="button"
                className={`icon-button small ${voice.screenEnabled ? 'selected' : ''}`}
                onClick={() => void startOrStopScreenShare()}
                title={voice.screenEnabled ? 'Parar transmissão' : 'Compartilhar tela'}
                aria-label={voice.screenEnabled ? 'Parar transmissão' : 'Compartilhar tela'}
              >
                <ShareIcon size={15} />
              </button>
              <button
                type="button"
                className="icon-button small danger"
                onClick={() => void voice.disconnect()}
                title="Sair do canal"
                aria-label="Sair do canal"
              >
                <LeaveIcon size={15} />
              </button>
            </div>
          </div>
        )}

        <footer className="sidebar-user">
          <Avatar name={session.displayName} accentColor={session.accentColor} avatarUrl={session.avatarUrl} />
          <div className="current-user-copy">
            <strong>{session.displayName}</strong>
            <span>{connectionLabel}</span>
          </div>
          <div className="sidebar-actions">
            <button
              className={`icon-button ${!voice.micEnabled ? 'danger' : ''}`}
              type="button"
              onClick={() => void voice.toggleMicrophone()}
              disabled={!voice.connected || voice.deafened}
              title={voice.micEnabled ? 'Desligar microfone' : 'Ligar microfone'}
              aria-label={voice.micEnabled ? 'Desligar microfone' : 'Ligar microfone'}
            >
              <IconSwap on={voice.micEnabled} onIcon={<MicIcon />} offIcon={<MicOffIcon />} />
            </button>
            <DeviceMenu
              devices={voice.audioInputs}
              selectedId={voice.selectedMicId}
              onSelect={(deviceId) => void voice.setMicrophoneDevice(deviceId)}
              label="Escolher microfone"
            />
            <button
              className={`icon-button ${voice.deafened ? 'danger' : ''}`}
              type="button"
              onClick={() => void voice.toggleDeafen()}
              disabled={!voice.connected}
              title={voice.deafened ? 'Ativar áudio' : 'Desativar áudio'}
              aria-label={voice.deafened ? 'Ativar áudio' : 'Desativar áudio'}
            >
              <IconSwap on={!voice.deafened} onIcon={<HeadphonesIcon />} offIcon={<HeadphonesOffIcon />} />
            </button>
            <DeviceMenu
              devices={voice.audioOutputs}
              selectedId={voice.selectedSpeakerId}
              onSelect={(deviceId) => void voice.setSpeakerDevice(deviceId)}
              label="Escolher saída de áudio"
            />
            <button
              ref={settingsButtonRef}
              className={`icon-button ${settingsOpen ? 'selected' : ''}`}
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="Configurações"
              aria-label="Configurações"
            >
              <SettingsIcon />
            </button>
          </div>
        </footer>
      </aside>

      <section className="main-panel">
        <header className="room-header">
          <div className="room-title">
            {activeTextChannel ? <span className="room-title-hash" aria-hidden="true">#</span> : <VoiceIcon size={18} />}
            <div>
              <h1>{activeTextChannel?.name || voice.currentChannel?.name || 'Nenhum canal selecionado'}</h1>
              <p>{activeTextChannel?.description || voice.currentChannel?.description || 'Escolha um canal na lista à esquerda.'}</p>
            </div>
          </div>
          {!activeTextChannel && (
            <div className="room-header-actions">
              <div className={`connection-state ${voice.connected ? 'online' : ''}`}><span />{connectionLabel}</div>
              {voice.connected && (
                <button
                  type="button"
                  className={`icon-button ${chatOpen ? 'selected' : ''}`}
                  onClick={() => setChatOpen((open) => !open)}
                  title={chatOpen ? 'Fechar chat' : 'Abrir chat'}
                  aria-label={chatOpen ? 'Fechar chat' : 'Abrir chat'}
                >
                  <MessageIcon size={17} />
                </button>
              )}
            </div>
          )}
        </header>

        {activeTextChannel ? (
          <TextChannelView
            channel={activeTextChannel}
            session={session}
            messageStyle={messageStyle}
            voiceChannelId={voice.currentChannel?.id ?? null}
            onOpenProfile={openUserProfile}
          />
        ) : (
        <>
        {voice.error && (
          <div className="error-banner" role="alert">
            <span><strong>Erro:</strong> {voice.error}</span>
            <button type="button" onClick={voice.clearError}>Fechar</button>
          </div>
        )}
        {!voice.canPlaybackAudio && voice.connected && (
          <button className="audio-permission" type="button" onClick={() => void voice.startAudio()}>Liberar reprodução de áudio</button>
        )}
        {voice.shareAudioActive && (
          <div className="audio-permission share-audio-notice">
            <span>
              {allowListenWhileSharing
                ? 'Compartilhando com áudio do sistema — a call é filtrada antes de ir pra transmissão, então ninguém deveria ouvir a própria voz de volta.'
                : 'Compartilhando com áudio do sistema — a voz dos outros está muda só pra você, pra garantir que não vaze na sua transmissão.'}
            </span>
            <button type="button" className="share-audio-notice-toggle" onClick={() => setAllowListenWhileSharing((current) => !current)}>
              {allowListenWhileSharing ? 'Ainda ouço eco — mutar os outros' : 'Voltar a ouvir todo mundo'}
            </button>
          </div>
        )}

        <div className={`room-content ${chatOpen && voice.connected ? 'with-chat' : ''}`}>
          <section className="stage-column">
            <div className="stage-content">
              {joiningId || voice.connectionState === ConnectionState.Connecting ? (
                <RoomSkeleton />
              ) : voice.connected ? (
                voice.screenTracks.length > 0 ? (
                  <ScreenStage
                    screens={voice.screenTracks}
                    streamVolumes={streamVolumes}
                    setStreamVolume={(identity, value) => setStreamVolumes((current) => ({ ...current, [identity]: value }))}
                    watchingIds={watchingScreenIds}
                    onWatch={(id) => setWatchingScreenIds((current) => new Set(current).add(id))}
                    onStopWatching={(id) =>
                      setWatchingScreenIds((current) => {
                        const next = new Set(current);
                        next.delete(id);
                        return next;
                      })
                    }
                  />
                ) : (
                  <div className="voice-idle-stage">
                    <VoiceIcon size={26} />
                    <h2>Você está em {voice.currentChannel?.name}</h2>
                    <p>Ninguém está compartilhando tela agora.</p>
                  </div>
                )
              ) : (
                <div className="disconnected-stage">
                  <VoiceIcon size={20} />
                  <h2>Sem canal de voz</h2>
                  <p>Selecione um canal para entrar na conversa.</p>
                </div>
              )}
            </div>

            {voice.connected && (
              <div className="voice-toolbar" aria-label="Controles de voz">
                <button
                  className={`voice-action ${!voice.micEnabled ? 'danger' : ''}`}
                  type="button"
                  onClick={() => void voice.toggleMicrophone()}
                  disabled={voice.deafened}
                  title={voice.micEnabled ? 'Desligar microfone' : 'Ligar microfone'}
                  aria-label={voice.micEnabled ? 'Desligar microfone' : 'Ligar microfone'}
                >
                  <IconSwap on={voice.micEnabled} onIcon={<MicIcon />} offIcon={<MicOffIcon />} />
                </button>
                <button
                  className={`voice-action ${voice.deafened ? 'danger' : ''}`}
                  type="button"
                  onClick={() => void voice.toggleDeafen()}
                  title={voice.deafened ? 'Ativar áudio' : 'Desativar áudio'}
                  aria-label={voice.deafened ? 'Ativar áudio' : 'Desativar áudio'}
                >
                  <IconSwap on={!voice.deafened} onIcon={<HeadphonesIcon />} offIcon={<HeadphonesOffIcon />} />
                </button>
                <span className="toolbar-divider" />
                <button
                  className={`voice-action ${voice.cameraEnabled ? 'sharing' : ''}`}
                  type="button"
                  onClick={() => void voice.toggleCamera()}
                  title={voice.cameraEnabled ? 'Desligar câmera' : 'Ligar câmera'}
                  aria-label={voice.cameraEnabled ? 'Desligar câmera' : 'Ligar câmera'}
                >
                  <IconSwap on={voice.cameraEnabled} onIcon={<CameraIcon />} offIcon={<CameraOffIcon />} />
                </button>
                <button
                  className={`voice-action wide ${voice.screenEnabled ? 'sharing' : ''}`}
                  type="button"
                  onClick={() => void startOrStopScreenShare()}
                  title={voice.screenEnabled ? 'Parar transmissão' : 'Compartilhar tela'}
                >
                  <ShareIcon />
                  <span>{voice.screenEnabled ? 'Parar transmissão' : 'Compartilhar tela'}</span>
                </button>
                <button className="voice-action leave" type="button" onClick={() => void voice.disconnect()} title="Sair do canal">
                  <LeaveIcon />
                  <span>Sair</span>
                </button>
              </div>
            )}
          </section>

          {chatOpen && voice.connected && (
          <aside className="chat-panel">
            <div className="chat-heading">
              <div className="chat-heading-info">
                <div><MessageIcon size={16} /><strong>Chat</strong></div>
                <span>{voice.currentChannel?.name || 'sem canal'}</span>
              </div>
              <button type="button" className="chat-close" onClick={() => setChatOpen(false)} aria-label="Fechar chat">
                <CloseIcon size={14} />
              </button>
            </div>
            <div
              className={`messages ${messageStyle === 'compact' ? 'compact' : ''} ${messageStyle === 'grouped' ? 'grouped' : ''}`}
              aria-live="polite"
            >
              {voice.messages.length === 0 ? (
                <div className="empty-chat"><strong>Nenhuma mensagem</strong><span>As mensagens pertencem ao canal atual.</span></div>
              ) : voice.messages.map((message, index) => {
                const previous = voice.messages[index - 1];
                const continued =
                  messageStyle === 'grouped' &&
                  previous?.senderId === message.senderId &&
                  message.sentAt - previous.sentAt < 5 * 60 * 1000;
                const senderAvatar =
                  message.senderId === session.id ? session.avatarUrl : remoteAvatarCache.get(message.senderId);
                const isBotMessage = message.senderId === MUSIC_BOT_IDENTITY;
                return (
                  <article className={`message ${continued ? 'continued' : ''}`} key={message.id}>
                    {isBotMessage ? (
                      <Avatar name={message.senderName} avatarUrl={senderAvatar} compact />
                    ) : (
                      <button
                        type="button"
                        className="message-avatar-trigger"
                        onClick={(event) => openUserProfile(message.senderId, event)}
                        title={`Ver perfil de ${message.senderName}`}
                      >
                        <Avatar name={message.senderName} avatarUrl={senderAvatar} compact />
                      </button>
                    )}
                    <div>
                      <header>
                        {isBotMessage ? (
                          <strong>
                            {message.senderName}
                            <span className="bot-badge">BOT</span>
                          </strong>
                        ) : (
                          <button type="button" className="message-name-trigger" onClick={(event) => openUserProfile(message.senderId, event)}>
                            {message.senderName}
                          </button>
                        )}
                        <time>{new Date(message.sentAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time>
                      </header>
                      <p>{message.text}</p>
                    </div>
                  </article>
                );
              })}
              <div ref={chatEndRef} />
            </div>
            <form className="chat-form" onSubmit={submitChat}>
              <input
                aria-label="Mensagem"
                maxLength={500}
                disabled={!voice.connected}
                value={chatText}
                onChange={(event) => setChatText(event.target.value)}
                placeholder={voice.connected ? 'Enviar mensagem' : 'Entre em um canal'}
              />
              <button type="submit" disabled={!voice.connected || !chatText.trim()}>Enviar</button>
            </form>
          </aside>
          )}

          {voice.connected && (
            <aside className="member-list" aria-label="Membros do canal">
              <div className="member-list-heading">
                <span>MEMBROS</span>
                <small>{voice.participants.length}</small>
              </div>
              <div className="member-list-scroll">
                {/* Lista única e com ordem estável — quem fala só ganha um destaque
                    visual (borda/fundo verde em .active-speaker), não muda de
                    posição. Alternar de grupo (Falando/Conectado) a cada fala
                    fazia a lista inteira pular pra cima e pra baixo. */}
                <div className="member-group">
                  <span className="member-group-title">Conectado — {typedParticipants.length}</span>
                  {typedParticipants.map(renderParticipantRow)}
                </div>
              </div>
            </aside>
          )}
        </div>
        </>
        )}
      </section>
    </main>
  );
}
