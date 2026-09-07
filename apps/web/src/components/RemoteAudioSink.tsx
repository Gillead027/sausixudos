import { useEffect, useRef } from 'react';
import { RemoteAudioTrack, RemoteParticipant, Track, type RemoteTrackPublication } from 'livekit-client';

interface RemoteAudioSinkProps {
  participant: RemoteParticipant;
  volume: number;
  streamVolume: number;
  outputVolume: number;
  deafened: boolean;
  trackVersion: string;
}

export function RemoteAudioSink({
  participant,
  volume,
  streamVolume,
  outputVolume,
  deafened,
  trackVersion,
}: RemoteAudioSinkProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const publications = Array.from(participant.audioTrackPublications.values()) as RemoteTrackPublication[];
    const elements = publications
      .filter((publication) => publication.source === Track.Source.Microphone || publication.source === Track.Source.ScreenShareAudio)
      .filter((publication): publication is RemoteTrackPublication & { track: RemoteAudioTrack } => publication.track instanceof RemoteAudioTrack)
      .map((publication) => {
        // Voz e áudio da transmissão de tela têm volumes independentes —
        // alguém pode querer ouvir a pessoa falando alto e o áudio do jogo
        // dela mais baixo (ou o contrário).
        const perTrackVolume = publication.source === Track.Source.ScreenShareAudio ? streamVolume : volume;
        const element = publication.track.attach();
        element.autoplay = true;
        element.muted = deafened;
        element.volume = (perTrackVolume / 100) * (outputVolume / 100);
        container.appendChild(element);
        return { element, track: publication.track };
      });

    return () => {
      for (const { element, track } of elements) {
        track.detach(element);
        element.remove();
      }
    };
  }, [participant, volume, streamVolume, outputVolume, deafened, trackVersion]);

  return <div ref={containerRef} className="audio-sink" aria-hidden="true" />;
}
