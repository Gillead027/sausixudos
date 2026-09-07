import { useEffect, useRef, useState } from 'react';
import { LocalVideoTrack, RemoteParticipant, RemoteVideoTrack } from 'livekit-client';
import type { ScreenTrackView } from '../livekit/useVoiceRoom';
import { FullscreenIcon, SpeakerIcon } from './Icons';

function VideoTile({
  view,
  volume,
  setVolume,
}: {
  view: ScreenTrackView;
  volume: number;
  setVolume: (value: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const isRemote = view.participant instanceof RemoteParticipant;

  useEffect(() => {
    const element = videoRef.current;
    const track = view.publication.track;
    if (!element || !(track instanceof RemoteVideoTrack || track instanceof LocalVideoTrack)) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [view]);

  return (
    <article className="screen-tile">
      {!ready && <div className="stream-skeleton"><span /><span /><span /></div>}
      <video ref={videoRef} autoPlay playsInline onLoadedMetadata={() => setReady(true)} />
      <div className="screen-label">
        <span className="live-dot" />
        {view.participant.name || view.participant.identity}
      </div>
      {isRemote && (
        <label className="screen-volume" title={`Volume da transmissão: ${volume}%`}>
          <SpeakerIcon size={13} />
          <input
            aria-label={`Volume da transmissão de ${view.participant.name || view.participant.identity}`}
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

export function ScreenStage({
  screens,
  streamVolumes,
  setStreamVolume,
}: {
  screens: ScreenTrackView[];
  streamVolumes: Record<string, number>;
  setStreamVolume: (identity: string, value: number) => void;
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
    console.log('[fullscreen] toggle clicked, current=', fullscreen, 'hasDesktopApi=', Boolean(window.desktop?.setFullscreen));
    const stage = stageRef.current;
    if (!stage) {
      console.error('[fullscreen] stageRef.current is null, aborting');
      return;
    }
    setFullscreenError('');
    try {
      if (window.desktop?.setFullscreen) {
        const nextFullscreen = !fullscreen;
        console.log('[fullscreen] calling window.desktop.setFullscreen(', nextFullscreen, ')');
        const result = await window.desktop.setFullscreen(nextFullscreen);
        console.log('[fullscreen] setFullscreen resolved with', result);
        setFullscreen(nextFullscreen);
        return;
      }
      if (document.fullscreenElement === stage) {
        await document.exitFullscreen();
      } else {
        if (document.fullscreenElement) await document.exitFullscreen();
        await stage.requestFullscreen();
      }
    } catch (error) {
      console.error('[fullscreen] toggleFullscreen threw:', error);
      setFullscreenError('Não foi possível ativar a tela cheia. Tente novamente.');
    }
  }

  return (
    <div className={`screen-stage screens-${Math.min(screens.length, 4)} ${fullscreen ? 'native-fullscreen' : ''}`} ref={stageRef}>
      <div className="stream-toolbar">
        <span>{screens.length === 1 ? '1 transmissão' : `${screens.length} transmissões`}</span>
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
      </div>
      {fullscreenError && <div className="fullscreen-error" role="alert">{fullscreenError}</div>}
      <div className="screen-grid">
        {screens.map((screen) => (
          <VideoTile
            key={screen.id}
            view={screen}
            volume={streamVolumes[screen.participant.identity] ?? 100}
            setVolume={(value) => setStreamVolume(screen.participant.identity, value)}
          />
        ))}
      </div>
    </div>
  );
}
