import { useEffect, useRef, useState } from 'react';
import { LocalVideoTrack, RemoteVideoTrack } from 'livekit-client';
import type { ScreenTrackView } from '../livekit/useVoiceRoom';
import { FullscreenIcon } from './Icons';

function VideoTile({ view }: { view: ScreenTrackView }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);

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
    </article>
  );
}

export function ScreenStage({ screens }: { screens: ScreenTrackView[] }) {
  const stageRef = useRef<HTMLDivElement>(null);

  return (
    <div className={`screen-stage screens-${Math.min(screens.length, 4)}`} ref={stageRef}>
      <div className="stream-toolbar">
        <span>{screens.length === 1 ? '1 transmissão' : `${screens.length} transmissões`}</span>
        <button type="button" onClick={() => void stageRef.current?.requestFullscreen()}>
          <FullscreenIcon />
          Tela cheia
        </button>
      </div>
      <div className="screen-grid">
        {screens.map((screen) => <VideoTile key={screen.id} view={screen} />)}
      </div>
    </div>
  );
}
