import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ACCENT_COLORS, type AccentColor, type PublicConfig, type RoomSummary, type UserSession, type VoiceChannel } from '@sausixudos/shared';
import {
  ConnectionState,
  LocalParticipant,
  RemoteParticipant,
  Track,
  type TrackPublication,
} from 'livekit-client';
import { api } from '../api';
import { useDelayedUnmount } from '../hooks/useDelayedUnmount';
import { type InputMode, type ShareQuality, useVoiceRoom } from '../livekit/useVoiceRoom';
import { getPerfMode, type PerfMode, setPerfMode } from '../perfMode';
import {
  CameraIcon,
  CameraOffIcon,
  ChevronIcon,
  CloseIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  LeaveIcon,
  MessageIcon,
  MicIcon,
  MicOffIcon,
  PaletteIcon,
  PlusIcon,
  SettingsIcon,
  ShareIcon,
  UserIcon,
  VoiceIcon,
} from './Icons';
import { RemoteAudioSink } from './RemoteAudioSink';
import { ScreenStage } from './ScreenStage';

type MessageStyle = 'default' | 'compact';
const MESSAGE_STYLE_KEY = 'gc:message-style';

function loadMessageStyle(): MessageStyle {
  return localStorage.getItem(MESSAGE_STYLE_KEY) === 'compact' ? 'compact' : 'default';
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

function avatarLetter(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

function avatarColorIndex(name: string): number {
  const index = Array.from(name).reduce((value, character) => value + character.charCodeAt(0), 0);
  return index % ACCENT_COLORS.length;
}

function Avatar({
  name,
  accentColor,
  speaking = false,
  compact = false,
}: {
  name: string;
  accentColor?: AccentColor | undefined;
  speaking?: boolean;
  compact?: boolean;
}) {
  const colorIndex = accentColor ? ACCENT_COLORS.indexOf(accentColor) : avatarColorIndex(name);
  return (
    <span
      className={`avatar avatar-color-${colorIndex} ${speaking ? 'speaking' : ''} ${compact ? 'compact' : ''}`}
    >
      {avatarLetter(name)}
      <span className="presence-dot" />
    </span>
  );
}

function participantAccentColor(
  participant: LocalParticipant | RemoteParticipant,
  ownAccentColor: AccentColor,
): AccentColor | undefined {
  if (participant instanceof LocalParticipant) return ownAccentColor;
  try {
    const metadata = participant.metadata ? (JSON.parse(participant.metadata) as { accentColor?: unknown }) : null;
    const color = metadata?.accentColor;
    return typeof color === 'string' && (ACCENT_COLORS as readonly string[]).includes(color)
      ? (color as AccentColor)
      : undefined;
  } catch {
    return undefined;
  }
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
}: {
  channel: VoiceChannel;
  summary: RoomSummary | undefined;
  active: boolean;
  loading: boolean;
  onClick: () => void;
  chatOpen: boolean;
  onToggleChat: () => void;
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
      {summary?.participants.map((participant) => (
        <div className="channel-user" key={participant.identity}>
          <Avatar name={participant.name} compact />
          <span>{participant.name}</span>
        </div>
      ))}
    </div>
  );
}

function ParticipantRow({
  participant,
  speaking,
  deafened,
  volume,
  setVolume,
  accentColor,
}: {
  participant: LocalParticipant | RemoteParticipant;
  speaking: boolean;
  deafened: boolean;
  volume: number;
  setVolume: (value: number) => void;
  accentColor?: AccentColor | undefined;
}) {
  const name = participant.name || participant.identity;
  const local = participant instanceof LocalParticipant;
  const microphone = participant.getTrackPublication(Track.Source.Microphone);
  const muted = !microphone || microphone.isMuted;
  const audioPublications = participant.audioTrackPublications as Map<string, TrackPublication>;
  const trackVersion = Array.from(audioPublications.values())
    .map((publication) => `${publication.trackSid}:${publication.isMuted}:${Boolean(publication.track)}`)
    .join('|');

  return (
    <div className={`participant-row ${speaking ? 'active-speaker' : ''}`}>
      <div className="participant-main">
        <Avatar name={name} accentColor={accentColor} speaking={speaking} compact />
        <div className="participant-copy">
          <strong>{name}{local ? ' (você)' : ''}</strong>
          <span>{speaking ? 'Falando' : muted ? 'Microfone desligado' : 'Conectado'}</span>
        </div>
        {muted && <MicOffIcon className="participant-muted" size={14} />}
      </div>
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
      {!local && participant instanceof RemoteParticipant && (
        <RemoteAudioSink participant={participant} volume={volume} deafened={deafened} trackVersion={trackVersion} />
      )}
    </div>
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
    try {
      const constraints: MediaStreamConstraints = {
        video: deviceId === 'default' ? true : { deviceId: { exact: deviceId } },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setTesting(true);
    } catch {
      stopPreview();
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
    </div>
  );
}

function SettingsModal({
  open,
  onClose,
  session,
  quality,
  setQuality,
  screenEnabled,
  perfMode,
  choosePerfMode,
  messageStyle,
  setMessageStyle,
  profileColor,
  setProfileColor,
  profileStatus,
  setProfileStatus,
  profileBio,
  setProfileBio,
  profilePronouns,
  setProfilePronouns,
  savingProfile,
  onSaveProfile,
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
}: {
  open: boolean;
  onClose: () => void;
  session: UserSession;
  quality: ShareQuality;
  setQuality: (quality: ShareQuality) => void;
  screenEnabled: boolean;
  perfMode: PerfMode;
  choosePerfMode: (mode: PerfMode) => void;
  messageStyle: MessageStyle;
  setMessageStyle: (style: MessageStyle) => void;
  profileColor: AccentColor;
  setProfileColor: (color: AccentColor) => void;
  profileStatus: string;
  setProfileStatus: (status: string) => void;
  profileBio: string;
  setProfileBio: (bio: string) => void;
  profilePronouns: string;
  setProfilePronouns: (pronouns: string) => void;
  savingProfile: boolean;
  onSaveProfile: () => void;
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
}) {
  const [listeningForKey, setListeningForKey] = useState(false);

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
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <div className={`settings-overlay ${open ? 'entering' : 'leaving'}`} role="dialog" aria-modal="true" aria-label="Configurações">
      <div className="settings-modal">
        <nav className="settings-nav">
          <span className="settings-nav-title">Configurações</span>
          <span className="settings-nav-group">Conta</span>
          <button type="button" className={section === 'profile' ? 'active' : ''} onClick={() => setSection('profile')}>
            <UserIcon size={15} /> Meu perfil
          </button>
          <span className="settings-nav-group">Aparência</span>
          <button type="button" className={section === 'voice' ? 'active' : ''} onClick={() => setSection('voice')}>
            <VoiceIcon size={15} /> Voz e vídeo
          </button>
          <button type="button" className={section === 'appearance' ? 'active' : ''} onClick={() => setSection('appearance')}>
            <PaletteIcon size={15} /> Aparência
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
                <label htmlFor="profile-status">Status</label>
                <input
                  id="profile-status"
                  maxLength={60}
                  value={profileStatus}
                  onChange={(event) => setProfileStatus(event.target.value)}
                  placeholder="Seu status (opcional)"
                />
                <label htmlFor="profile-pronouns">Pronomes</label>
                <input
                  id="profile-pronouns"
                  maxLength={30}
                  value={profilePronouns}
                  onChange={(event) => setProfilePronouns(event.target.value)}
                  placeholder="ex.: ele/dele, ela/dela (opcional)"
                />
                <label htmlFor="profile-bio">Sobre mim</label>
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
                <button className="save-profile-button" type="button" disabled={savingProfile} onClick={onSaveProfile}>
                  {savingProfile ? 'Salvando…' : 'Salvar alterações'}
                </button>
              </div>
              <div className="settings-pane-side">
                <span className="settings-side-title">Pré-visualização</span>
                <div className="profile-preview">
                  <div className={`profile-preview-banner avatar-color-${ACCENT_COLORS.indexOf(profileColor)}`} />
                  <Avatar name={session.displayName} accentColor={profileColor} />
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
                <h2>Voz e vídeo</h2>
                <div className="settings-field-row">
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
                </div>

                <span className="settings-label">Teste de microfone</span>
                <MicTest deviceId={selectedMicId} />

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
              </div>
              <div className="settings-pane-side">
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
              </div>
            </div>
          )}

          {section === 'appearance' && (
            <div className="settings-pane two-column">
              <div className="settings-pane-main">
                <h2>Aparência</h2>
                <span className="settings-label">Desempenho</span>
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

                <span className="settings-label">Exibição das mensagens</span>
                <div className="perf-toggle" role="group" aria-label="Estilo de exibição das mensagens">
                  <button type="button" className={messageStyle === 'default' ? 'active' : ''} onClick={() => setMessageStyle('default')}>
                    Padrão
                  </button>
                  <button type="button" className={messageStyle === 'compact' ? 'active' : ''} onClick={() => setMessageStyle('compact')}>
                    Compacto
                  </button>
                </div>
              </div>
              <div className="settings-pane-side">
                <span className="settings-side-title">Pré-visualização</span>
                <div className="appearance-preview">
                  <div className={`messages ${messageStyle === 'compact' ? 'compact' : ''}`}>
                    <article className="message">
                      <Avatar name={session.displayName} accentColor={profileColor} compact />
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
  const [quality, setQuality] = useState<ShareQuality>('720p60');
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [chatText, setChatText] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [perfMode, setPerfModeState] = useState<PerfMode>(() => getPerfMode());
  const [messageStyle, setMessageStyleState] = useState<MessageStyle>(() => loadMessageStyle());
  const [profileColor, setProfileColor] = useState<AccentColor>(session.accentColor);
  const [profileStatus, setProfileStatus] = useState(session.statusText);
  const [profileBio, setProfileBio] = useState(session.bio);
  const [profilePronouns, setProfilePronouns] = useState(session.pronouns);
  const [savingProfile, setSavingProfile] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  function choosePerfMode(mode: PerfMode) {
    setPerfMode(mode);
    setPerfModeState(mode);
  }

  function setMessageStyle(style: MessageStyle) {
    localStorage.setItem(MESSAGE_STYLE_KEY, style);
    setMessageStyleState(style);
  }

  async function saveProfile() {
    setSavingProfile(true);
    try {
      const { user } = await api.updateProfile(profileColor, profileStatus, profileBio, profilePronouns);
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

  async function joinChannel(channel: VoiceChannel) {
    const startViewTransition = (document as ViewTransitionDocument).startViewTransition?.bind(document);
    if (perfMode === 'full' && startViewTransition) {
      startViewTransition(() => flushSync(() => setJoiningId(channel.id)));
    } else {
      setJoiningId(channel.id);
    }
    await voice.connect(channel);
    setJoiningId(null);
  }

  async function submitChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chatText.trim()) return;
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
        deafened={voice.deafened}
        volume={volumes[participant.identity] ?? 100}
        setVolume={(value) => setVolumes((current) => ({ ...current, [participant.identity]: value }))}
        accentColor={participantAccentColor(participant, session.accentColor)}
      />
    );
  }

  const typedParticipants = voice.participants as (LocalParticipant | RemoteParticipant)[];
  const speakingParticipants = typedParticipants.filter((participant) => voice.speakers.has(participant.identity));
  const otherParticipants = typedParticipants.filter((participant) => !voice.speakers.has(participant.identity));

  return (
    <main className="workspace">
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        session={session}
        quality={quality}
        setQuality={setQuality}
        screenEnabled={voice.screenEnabled}
        perfMode={perfMode}
        choosePerfMode={choosePerfMode}
        messageStyle={messageStyle}
        setMessageStyle={setMessageStyle}
        profileColor={profileColor}
        setProfileColor={setProfileColor}
        profileStatus={profileStatus}
        setProfileStatus={setProfileStatus}
        profileBio={profileBio}
        setProfileBio={setProfileBio}
        profilePronouns={profilePronouns}
        setProfilePronouns={setProfilePronouns}
        savingProfile={savingProfile}
        onSaveProfile={() => void saveProfile()}
        onSignOut={() => void voice.disconnect().finally(onSignOut)}
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
      />
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

        <nav className="channels" aria-label="Canais de voz">
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
                onClick={() => void voice.toggleScreenShare(quality)}
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
          <Avatar name={session.displayName} accentColor={session.accentColor} />
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
            <VoiceIcon size={18} />
            <div>
              <h1>{voice.currentChannel?.name || 'Nenhum canal selecionado'}</h1>
              <p>{voice.currentChannel?.description || 'Escolha um canal na lista à esquerda.'}</p>
            </div>
          </div>
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
        </header>

        {voice.error && (
          <div className="error-banner" role="alert">
            <span><strong>Erro:</strong> {voice.error}</span>
            <button type="button" onClick={voice.clearError}>Fechar</button>
          </div>
        )}
        {!voice.canPlaybackAudio && voice.connected && (
          <button className="audio-permission" type="button" onClick={() => void voice.startAudio()}>Liberar reprodução de áudio</button>
        )}

        <div className={`room-content ${chatOpen && voice.connected ? 'with-chat' : ''}`}>
          <section className="stage-column">
            <div className="stage-content">
              {joiningId || voice.connectionState === ConnectionState.Connecting ? (
                <RoomSkeleton />
              ) : voice.connected ? (
                voice.screenTracks.length > 0 ? (
                  <ScreenStage screens={voice.screenTracks} />
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
                  onClick={() => void voice.toggleScreenShare(quality)}
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
            <div className={`messages ${messageStyle === 'compact' ? 'compact' : ''}`} aria-live="polite">
              {voice.messages.length === 0 ? (
                <div className="empty-chat"><strong>Nenhuma mensagem</strong><span>As mensagens pertencem ao canal atual.</span></div>
              ) : voice.messages.map((message) => (
                <article className="message" key={message.id}>
                  <Avatar name={message.senderName} compact />
                  <div>
                    <header>
                      <strong>{message.senderName}</strong>
                      <time>{new Date(message.sentAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time>
                    </header>
                    <p>{message.text}</p>
                  </div>
                </article>
              ))}
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
                {speakingParticipants.length > 0 && (
                  <div className="member-group">
                    <span className="member-group-title">Falando — {speakingParticipants.length}</span>
                    {speakingParticipants.map(renderParticipantRow)}
                  </div>
                )}
                {otherParticipants.length > 0 && (
                  <div className="member-group">
                    <span className="member-group-title">Conectado — {otherParticipants.length}</span>
                    {otherParticipants.map(renderParticipantRow)}
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      </section>
    </main>
  );
}
