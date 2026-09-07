import { useEffect, useRef, useState } from 'react';
import { LocalVideoTrack, RemoteParticipant, RemoteVideoTrack, Track } from 'livekit-client';
import type { ScreenTrackView } from '../livekit/useVoiceRoom';
import { EyeIcon, EyeOffIcon, FullscreenIcon, ShareIcon, SpeakerIcon } from './Icons';

function attachVideo(view: ScreenTrackView, element: HTMLVideoElement | null): (() => void) | undefined {
  const track = view.publication.track;
  if (!element || !(track instanceof RemoteVideoTrack || track instanceof LocalVideoTrack)) return undefined;
  track.attach(element);
  return () => track.detach(element);
}

/** Tile grande da transmissão sendo assistida — passa o mouse pra ver "Sair da transmissão". */
function HeroTile({
  view,
  volume,
  setVolume,
  onStopWatching,
}: {
  view: ScreenTrackView;
  volume: number;
  setVolume: (value: number) => void;
  onStopWatching: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const isRemote = view.participant instanceof RemoteParticipant;
  const name = view.participant.name || view.participant.identity;

  useEffect(() => attachVideo(view, videoRef.current), [view]);

  return (
    <article className="hero-tile">
      {!ready && <div className="stream-skeleton"><span /><span /><span /></div>}
      <video ref={videoRef} autoPlay playsInline onLoadedMetadata={() => setReady(true)} />
      <div className="screen-label">
        <span className="live-dot" />
        {name}
      </div>
      <div className="hero-tile-overlay">
        <button type="button" className="hero-stop-watching" onClick={onStopWatching}>
          <EyeOffIcon size={14} /> Sair da transmissão
        </button>
      </div>
      {isRemote && (
        <label className="screen-volume" title={`Volume da transmissão: ${volume}%`} onClick={(event) => event.stopPropagation()}>
          <SpeakerIcon size={13} />
          <input
            aria-label={`Volume da transmissão de ${name}`}
            type="range"
            min="0"
            max="100"
            value={volume}
            onChange={(event) => setVolume(Number(event.target.value))}
          />
          <output>{volume}</output>
        </label>
      )}
    </article>
  );
}

/** Miniatura de câmera na galeria — sempre visível, sem precisar clicar em nada (é só uma chamada de vídeo normal). */
function CameraGalleryTile({ view }: { view: ScreenTrackView }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const name = view.participant.name || view.participant.identity;

  useEffect(() => attachVideo(view, videoRef.current), [view]);

  return (
    <article className="gallery-tile">
      {!ready && <div className="stream-skeleton"><span /><span /><span /></div>}
      <video ref={videoRef} autoPlay playsInline muted={view.participant instanceof RemoteParticipant === false} onLoadedMetadata={() => setReady(true)} />
      <div className="screen-label small">{name}</div>
    </article>
  );
}

/** Card de transmissão ainda não assistida — passa o mouse pra ver "Ver transmissão". */
function ShareGalleryTile({ view, onWatch }: { view: ScreenTrackView; onWatch: () => void }) {
  const name = view.participant.name || view.participant.identity;
  return (
    <button type="button" className="gallery-tile share-placeholder" onClick={onWatch}>
      <div className="share-placeholder-icon"><ShareIcon size={18} /></div>
      <div className="screen-label small"><span className="live-dot" />{name}</div>
      <div className="gallery-tile-overlay">
        <span><EyeIcon size={14} /> Ver transmissão</span>
      </div>
    </button>
  );
}

export function ScreenStage({
  screens,
  streamVolumes,
  setStreamVolume,
  watchingIds,
  onWatch,
  onStopWatching,
}: {
  screens: ScreenTrackView[];
  streamVolumes: Record<string, number>;
  setStreamVolume: (identity: string, value: number) => void;
  watchingIds: Set<string>;
  onWatch: (id: string) => void;
  onStopWatching: (id: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');

  useEffect(() => {
    const handleFullscreenChange = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    let unsubscribeDesktop: (() => void) | undefined;
    if (window.desktop?.getFullscreen) {
      void window.desktop.getFullscreen().then(setFullscreen).catch(() => {});
      unsubscribeDesktop = window.desktop.onFullscreenChanged?.(setFullscreen);
    }
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      unsubscribeDesktop?.();
    };
  }, []);

  useEffect(() => {
    if (!fullscreen || !window.desktop?.setFullscreen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void window.desktop?.setFullscreen?.(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [fullscreen]);

  async function toggleFullscreen() {
    const stage = stageRef.current;
    if (!stage) return;
    setFullscreenError('');
    try {
      if (window.desktop?.setFullscreen) {
        const nextFullscreen = !fullscreen;
        await window.desktop.setFullscreen(nextFullscreen);
        setFullscreen(nextFullscreen);
        return;
      }
      if (document.fullscreenElement === stage) {
        await document.exitFullscreen();
      } else {
        if (document.fullscreenElement) await document.exitFullscreen();
        await stage.requestFullscreen();
      }
    } catch {
      setFullscreenError('Não foi possível ativar a tela cheia. Tente novamente.');
    }
  }

  // Câmera é só uma chamada de vídeo normal (sempre visível, em miniatura na
  // galeria). Transmissão de tela é opt-in: assistida vira o tile grande em
  // foco, não assistida fica como um card na galeria com "Ver transmissão"
  // no hover — nunca misturados em blocos do mesmo tamanho.
  const cameraTiles = screens.filter((screen) => screen.publication.source === Track.Source.Camera);
  const shareScreens = screens.filter((screen) => screen.publication.source === Track.Source.ScreenShare);
  const heroShares = shareScreens.filter((screen) => watchingIds.has(screen.id));
  const unwatchedShares = shareScreens.filter((screen) => !watchingIds.has(screen.id));
  const hasHero = heroShares.length > 0;

  return (
    <div className={`screen-stage ${fullscreen ? 'native-fullscreen' : ''} ${hasHero ? 'has-hero' : ''}`} ref={stageRef}>
      <div className="stream-toolbar">
        <span>{shareScreens.length === 1 ? '1 transmissão' : `${shareScreens.length} transmissões`}</span>
        {hasHero && (
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? 'Sair da tela cheia' : 'Abrir transmissão em tela cheia'}
            title={fullscreen ? 'Sair da tela cheia (Esc)' : 'Tela cheia'}
          >
            <FullscreenIcon />
            {fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
          </button>
        )}
      </div>
      {fullscreenError && <div className="fullscreen-error" role="alert">{fullscreenError}</div>}
      <div className="stage-body">
        {hasHero && (
          <div className="hero-row">
            {heroShares.map((screen) => (
              <HeroTile
                key={screen.id}
                view={screen}
                volume={streamVolumes[screen.participant.identity] ?? 100}
                setVolume={(value) => setStreamVolume(screen.participant.identity, value)}
                onStopWatching={() => onStopWatching(screen.id)}
              />
            ))}
          </div>
        )}
        {(cameraTiles.length > 0 || unwatchedShares.length > 0) && (
          <div className="gallery-row">
            {unwatchedShares.map((screen) => (
              <ShareGalleryTile key={screen.id} view={screen} onWatch={() => onWatch(screen.id)} />
            ))}
            {cameraTiles.map((screen) => (
              <CameraGalleryTile key={screen.id} view={screen} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
