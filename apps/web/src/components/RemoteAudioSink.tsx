import { useEffect, useRef } from 'react';
import { RemoteAudioTrack, RemoteParticipant, Track, type RemoteTrackPublication } from 'livekit-client';

interface RemoteAudioSinkProps {
  participant: RemoteParticipant;
  volume: number;
  streamVolume: number;
  outputVolume: number;
  soundboardVolume: number;
  deafened: boolean;
  trackVersion: string;
}

// Tracks de soundboard não têm Source dedicado no LiveKit — publicadas como
// Unknown com name "soundboard" (ver useVoiceRoom.ts, playSoundboardSound).
// Sem esse reconhecimento aqui, elas nunca ganhariam um elemento <audio> e
// ninguém além de quem tocou ouviria o som.
function isSoundboardPublication(publication: RemoteTrackPublication): boolean {
  return publication.source === Track.Source.Unknown && publication.trackName === 'soundboard';
}

export function RemoteAudioSink({
  participant,
  volume,
  streamVolume,
  outputVolume,
  soundboardVolume,
  deafened,
  trackVersion,
}: RemoteAudioSinkProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const publications = Array.from(participant.audioTrackPublications.values()) as RemoteTrackPublication[];
    const elements = publications
      .filter(
        (publication) =>
          publication.source === Track.Source.Microphone ||
          publication.source === Track.Source.ScreenShareAudio ||
          isSoundboardPublication(publication),
      )
      .filter((publication): publication is RemoteTrackPublication & { track: RemoteAudioTrack } => publication.track instanceof RemoteAudioTrack)
      .map((publication) => {
        // Voz, áudio de transmissão de tela e soundboard têm volumes
        // independentes — alguém pode querer ouvir a pessoa falando alto e
        // o jogo dela (ou os sons que ela dispara) mais baixo.
        const perTrackVolume = isSoundboardPublication(publication)
          ? soundboardVolume
          : publication.source === Track.Source.ScreenShareAudio
            ? streamVolume
            : volume;
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
  }, [participant, volume, streamVolume, outputVolume, soundboardVolume, deafened, trackVersion]);

  return <div ref={containerRef} className="audio-sink" aria-hidden="true" />;
}
