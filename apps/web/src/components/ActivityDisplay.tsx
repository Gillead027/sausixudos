import { useEffect, useState } from 'react';
import type { Activity, ListeningActivity } from '@sausixudos/shared';
import { GameControllerIcon, MusicNoteIcon } from './Icons';

export function formatActivity(activity: Activity): string {
  if (activity.kind === 'playing') return `Jogando ${activity.name}`;
  return activity.artist
    ? `Ouvindo ${activity.title} de ${activity.artist}`
    : `Ouvindo ${activity.app} — ${activity.title}`;
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// positionMs/updatedAt são uma amostra pontual (ver apps/desktop/src/activity.ts)
// — o tempo decorrido de verdade é projetado localmente a partir dela em vez
// de esperar uma nova amostra chegar pela rede a cada segundo.
function useElapsedMs(activity: ListeningActivity | null): number | undefined {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!activity || activity.positionMs === undefined || activity.updatedAt === undefined) return;
    const interval = setInterval(() => forceTick((value) => value + 1), 1000);
    return () => clearInterval(interval);
  }, [activity?.positionMs, activity?.updatedAt]);

  if (!activity || activity.positionMs === undefined || activity.updatedAt === undefined) return undefined;
  const elapsed = activity.positionMs + (Date.now() - activity.updatedAt);
  return activity.durationMs !== undefined ? Math.min(elapsed, activity.durationMs) : Math.max(0, elapsed);
}

// Linha compacta pra lugares apertados (lista de membros): ícone + uma linha
// de texto, sem capa/barra de progresso.
export function ActivityLine({ activity }: { activity: Activity }) {
  return (
    <span className="activity-line">
      {activity.kind === 'playing' ? <GameControllerIcon size={11} /> : <MusicNoteIcon size={11} />}
      <span>{formatActivity(activity)}</span>
    </span>
  );
}

// Card completo (capa do álbum, barra de progresso, tempo decorrido/total) —
// usado no popover de perfil, onde há espaço de verdade. positionMs/
// durationMs/thumbnailDataUrl são opcionais porque nem todo app de mídia
// publica timeline ou arte pro Windows: sem eles, mostra só título/artista.
export function ListeningActivityCard({ activity }: { activity: ListeningActivity }) {
  const elapsedMs = useElapsedMs(activity);
  const hasProgress = activity.durationMs !== undefined && elapsedMs !== undefined && activity.durationMs > 0;
  const progressPercent = hasProgress ? Math.min(100, (elapsedMs! / activity.durationMs!) * 100) : 0;

  return (
    <div className="listening-activity-card">
      <div className="listening-activity-heading">
        <MusicNoteIcon size={11} />
        <span>Ouvindo {activity.app}</span>
      </div>
      <div className="listening-activity-body">
        {activity.thumbnailDataUrl ? (
          <img className="listening-activity-art" src={activity.thumbnailDataUrl} alt="" />
        ) : (
          <div className="listening-activity-art placeholder" aria-hidden="true">
            <MusicNoteIcon size={18} />
          </div>
        )}
        <div className="listening-activity-meta">
          <strong>{activity.title}</strong>
          {activity.artist && <span>{activity.artist}</span>}
        </div>
      </div>
      {hasProgress && (
        <div className="listening-activity-progress">
          <div className="listening-activity-track">
            <div className="listening-activity-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="listening-activity-times">
            <span>{formatClock(elapsedMs!)}</span>
            <span>{formatClock(activity.durationMs!)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
