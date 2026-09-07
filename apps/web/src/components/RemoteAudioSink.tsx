import { useEffect, useRef } from 'react';
import { RemoteAudioTrack, RemoteParticipant, Track } from 'livekit-client';

interface RemoteAudioSinkProps {
  participant: RemoteParticipant;
  volume: number;
  deafened: boolean;
  trackVersion: string;
}

export function RemoteAudioSink({ participant, volume, deafened, trackVersion }: RemoteAudioSinkProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const tracks = Array.from(participant.audioTrackPublications.values())
      .filter(
        (publication) =>
          publication.source === Track.Source.Microphone ||
          publication.source === Track.Source.ScreenShareAudio,
      )
      .map((publication) => publication.track)
      .filter((track): track is RemoteAudioTrack => track instanceof RemoteAudioTrack);

    const elements = tracks.map((track) => {
      const element = track.attach();
      element.autoplay = true;
      element.muted = deafened;
      element.volume = volume / 100;
      container.appendChild(element);
      return { element, track };
    });

    return () => {
      for (const { element, track } of elements) {
        track.detach(element);
        element.remove();
      }
    };
  }, [participant, volume, deafened, trackVersion]);

  return <div ref={containerRef} className="audio-sink" aria-hidden="true" />;
}
