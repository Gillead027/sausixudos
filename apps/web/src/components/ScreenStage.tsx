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
