import psList from 'ps-list';
import { getActiveSessions, onSessionsChanged, shutdown as shutdownMediaSessions } from 'windows-media-sessions';
import type { Activity } from '@sausixudos/shared';
import { matchKnownGame } from './gameList.js';

const GAME_POLL_INTERVAL_MS = 12_000;

function activityKey(activity: Activity | null): string {
  if (!activity) return '';
  return activity.kind === 'playing'
    ? `playing:${activity.name}`
    : `listening:${activity.app}:${activity.artist}:${activity.title}`;
}

/**
 * Monitora jogo em execução (via lista de processos) e mídia tocando (via
 * GlobalSystemMediaTransportControlsSessionManager do Windows, exposto pelo
 * windows-media-sessions) e chama onChange sempre que a atividade resultante
 * mudar. Jogo tem prioridade sobre mídia quando os dois estão ativos ao
 * mesmo tempo — evita mostrar "ouvindo X" enquanto a pessoa está claramente
 * jogando, que é a informação mais relevante das duas.
 */
export function startActivityMonitor(onChange: (activity: Activity | null) => void): () => void {
  let currentGame: string | null = null;
  let currentMedia: Activity | null = null;
  let lastKey = '';
  let stopped = false;

  const publish = () => {
    const activity: Activity | null = currentGame ? { kind: 'playing', name: currentGame } : currentMedia;
    const key = activityKey(activity);
    if (key === lastKey) return;
    lastKey = key;
    onChange(activity);
  };

  const pollGames = async () => {
    if (stopped) return;
    try {
      const processes = await psList();
      currentGame = matchKnownGame(processes.map((entry) => entry.name));
    } catch {
      // Sem lista de processos disponível (permissão negada, etc.) — segue
      // sem detecção de jogo, o resto do app continua funcionando normal.
      currentGame = null;
    }
    publish();
  };

  void pollGames();
  const gameInterval = setInterval(() => void pollGames(), GAME_POLL_INTERVAL_MS);

  const unsubscribeMedia = onSessionsChanged((sessions) => {
    const playing = sessions.find((entry) => entry.playbackStatus === 'playing' && entry.title);
    currentMedia = playing
      ? {
          kind: 'listening',
          app: playing.sourceAppDisplayName || playing.sourceAppUserModelId,
          title: playing.title ?? '',
          artist: playing.artist ?? '',
        }
      : null;
    publish();
  });
  // Estado inicial — onSessionsChanged só emite a partir da próxima mudança.
  void getActiveSessions()
    .then((sessions) => {
      const playing = sessions.find((entry) => entry.playbackStatus === 'playing' && entry.title);
      currentMedia = playing
        ? {
            kind: 'listening',
            app: playing.sourceAppDisplayName || playing.sourceAppUserModelId,
            title: playing.title ?? '',
            artist: playing.artist ?? '',
          }
        : null;
      publish();
    })
    .catch(() => {
      // Backend de sessões de mídia indisponível — sem detecção de música,
      // mas a detecção de jogo continua funcionando independentemente.
    });

  return () => {
    stopped = true;
    clearInterval(gameInterval);
    unsubscribeMedia();
    void shutdownMediaSessions();
  };
}
