import { useEffect, useState } from 'react';
import type { MusicCommandResponse, MusicNowPlayingCard } from '@sausixudos/shared';

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

type GlyphName = 'speaker' | 'heart' | 'pause' | 'play' | 'skip' | 'stop' | 'repeat' | 'grid' | 'up' | 'down' | 'next';

function Glyph({ name }: { name: GlyphName }) {
  const common = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (name === 'speaker') return <svg {...common}><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16.5 8.5a5 5 0 0 1 0 7" /></svg>;
  if (name === 'heart') return <svg {...common}><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" /></svg>;
  if (name === 'pause') return <svg {...common}><path d="M8 5v14M16 5v14" /></svg>;
  if (name === 'play') return <svg {...common}><path d="m8 5 11 7-11 7V5Z" /></svg>;
  if (name === 'skip') return <svg {...common}><path d="m6 5 10 7-10 7V5ZM18 5v14" /></svg>;
  if (name === 'stop') return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" /></svg>;
  if (name === 'repeat') return <svg {...common}><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>;
  if (name === 'grid') return <svg {...common}><rect x="4" y="4" width="6" height="6" /><rect x="14" y="4" width="6" height="6" /><rect x="4" y="14" width="6" height="6" /><rect x="14" y="14" width="6" height="6" /></svg>;
  if (name === 'up') return <svg {...common}><path d="M7 10v10H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h3ZM7 20h9.4a2 2 0 0 0 2-1.6l1.3-6A2 2 0 0 0 17.8 10H14l.7-3.2A2.8 2.8 0 0 0 12 3.5L7 10Z" /></svg>;
  if (name === 'down') return <svg {...common}><path d="M7 14V4H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h3ZM7 4h9.4a2 2 0 0 1 2 1.6l1.3 6A2 2 0 0 1 17.8 14H14l.7 3.2A2.8 2.8 0 0 1 12 20.5L7 14Z" /></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M9.5 9a2.8 2.8 0 0 1 5.4 1c0 2-2.9 2.3-2.9 4.3M12 18h.01" /></svg>;
}

interface MusicCardProps {
  card: MusicNowPlayingCard;
  onCommand?: (command: string) => Promise<MusicCommandResponse>;
}

export function MusicCard({ card, onCommand }: MusicCardProps) {
  const [liveCard, setLiveCard] = useState(card);
  const [positionMs, setPositionMs] = useState(card.positionMs);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('');
  const [liked, setLiked] = useState(false);
  const [reaction, setReaction] = useState<'love' | 'nope' | null>(null);
  const [autoplay, setAutoplay] = useState(false);

  useEffect(() => {
    setLiveCard(card);
    setPositionMs(card.positionMs);
  }, [card.title, card.webUrl, card.requestedBy, card.durationMs]);

  useEffect(() => {
    if (liveCard.state !== 'PLAYING') return;
    const timer = window.setInterval(() => {
      setPositionMs((current) => {
        const next = current + 1_000;
        return liveCard.durationMs > 0 ? Math.min(next, liveCard.durationMs) : next;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [liveCard.durationMs, liveCard.state]);

  const duration = Math.max(0, liveCard.durationMs);
  const progress = duration > 0 ? Math.max(0, Math.min(100, (positionMs / duration) * 100)) : 0;
  const paused = liveCard.state === 'PAUSED';

  async function run(command: string) {
    if (!onCommand || busy) return;
    setBusy(command);
    setStatus('');
    try {
      const response = await onCommand(command);
      setStatus(response.message);
      if (response.nowPlaying) {
        setLiveCard(response.nowPlaying);
        setPositionMs(response.nowPlaying.positionMs);
      } else if (command === '/pause') {
        setLiveCard((current) => ({ ...current, state: 'PAUSED' }));
      } else if (command === '/resume') {
        setLiveCard((current) => ({ ...current, state: 'PLAYING' }));
      } else if (command === '/stop') {
        setLiveCard((current) => ({ ...current, state: 'IDLE' }));
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'N\u00e3o foi poss\u00edvel executar o controle.');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="sausimusic-player-shell">
      <div className="sausimusic-embed">
        <div className="sausimusic-embed-title">Reproduzindo agora</div>
        <div className="sausimusic-divider" />
        <div className="sausimusic-track-row">
          <div className="sausimusic-track-copy">
            {liveCard.webUrl ? (
              <a className="sausimusic-track-title" href={liveCard.webUrl} target="_blank" rel="noreferrer">{liveCard.title}</a>
            ) : <strong className="sausimusic-track-title">{liveCard.title}</strong>}
            <div className="sausimusic-detail-line"><span className="sausimusic-bullet" aria-hidden="true" /><span>Added by <b>@{liveCard.requestedBy}</b></span></div>
            <div className="sausimusic-detail-line"><span className="sausimusic-bullet" aria-hidden="true" /><span className="sausimusic-voice-pill"><Glyph name="speaker" />{liveCard.voiceChannelId?.toUpperCase() || 'GERAL'}</span></div>
          </div>
          <div className="sausimusic-art-column">
            {liveCard.thumbnailUrl ? (
              <img className="sausimusic-cover" src={liveCard.thumbnailUrl} alt={`Capa de ${liveCard.title}`} />
            ) : (
              <div className="sausimusic-cover sausimusic-cover-placeholder" aria-hidden="true"><span className="sausimusic-cover-bars"><i /><i /><i /></span></div>
            )}
            <button type="button" className={`sausimusic-like ${liked ? 'active' : ''}`} onClick={() => setLiked((value) => !value)}><Glyph name="heart" />Like</button>
          </div>
        </div>

        <div className="sausimusic-stats">Queue Size: <code>{liveCard.queueSize ?? 0}</code><span>&middot;</span>Volume: <code>{liveCard.volume}%</code><span>&middot;</span>Loop: <code>Off</code></div>
        <div className="sausimusic-progress" aria-label={`Progresso ${formatTime(positionMs)} de ${formatTime(duration)}`}><span style={{ width: `${progress}%` }} /><i style={{ left: `${progress}%` }} /></div>
        <div className="sausimusic-time-row"><span>{formatTime(positionMs)}</span><span>{duration > 0 ? formatTime(duration) : '--:--'}</span></div>

        <div className="sausimusic-controls">
          <button type="button" disabled={Boolean(busy)} onClick={() => void run(paused ? '/resume' : '/pause')}><Glyph name={paused ? 'play' : 'pause'} />{paused ? 'Resume' : 'Pause'}</button>
          <button type="button" disabled={Boolean(busy)} onClick={() => void run('/skip')}><Glyph name="skip" />Skip</button>
          <button type="button" disabled={Boolean(busy)} onClick={() => void run('/stop')}><Glyph name="stop" />Stop</button>
          <button type="button" className={autoplay ? 'active' : ''} onClick={() => setAutoplay((value) => !value)}><Glyph name="repeat" />AutoPlay</button>
          <button type="button" onClick={() => setStatus('Dashboard do SausiMusic em breve.')}><Glyph name="grid" />Dashboard</button>
        </div>
        {status && <div className="sausimusic-control-status" role="status">{status}</div>}
      </div>

      <div className="sausimusic-reactions" aria-label={'Rea\u00e7\u00f5es do player'}>
        <button type="button" className={reaction === 'love' ? 'active' : ''} onClick={() => setReaction(reaction === 'love' ? null : 'love')}><Glyph name="up" />Love this</button>
        <button type="button" className={reaction === 'nope' ? 'active' : ''} onClick={() => setReaction(reaction === 'nope' ? null : 'nope')}><Glyph name="down" />Not for me</button>
        <button type="button" disabled={Boolean(busy)} onClick={() => void run('/queue')}><Glyph name="next" />What's next?</button>
      </div>
    </div>
  );
}
