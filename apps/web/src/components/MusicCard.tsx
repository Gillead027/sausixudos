import type { MusicNowPlayingCard } from '@sausixudos/shared';

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function MusicCard({ card }: { card: MusicNowPlayingCard }) {
  const duration = Math.max(0, card.durationMs);
  const progress = duration > 0
    ? Math.max(0, Math.min(100, (card.positionMs / duration) * 100))
    : 0;
  return (
    <div className="music-now-card">
      {card.thumbnailUrl ? (
        <img className="music-now-thumb" src={card.thumbnailUrl} alt="" />
      ) : (
        <div className="music-now-thumb placeholder" aria-hidden="true">♪</div>
      )}
      <div className="music-now-body">
        <span className="music-now-label">TOCANDO AGORA</span>
        {card.webUrl ? (
          <a href={card.webUrl} target="_blank" rel="noreferrer" className="music-now-title">{card.title}</a>
        ) : <strong className="music-now-title">{card.title}</strong>}
        <span className="music-now-author">{card.author}</span>        <div className="music-now-progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="music-now-meta">
          <span>{formatTime(card.positionMs)} / {duration > 0 ? formatTime(duration) : '--:--'}</span>
          <span>{card.providerId.toUpperCase()} · {card.volume}%</span>
        </div>
        <small>Pedido por {card.requestedBy}</small>
      </div>
    </div>
  );
}
