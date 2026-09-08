import psList from 'ps-list';
import {
  getActiveSessions,
  onSessionsChanged,
  shutdown as shutdownMediaSessions,
  type MediaSession,
} from 'windows-media-sessions';
import type { Activity } from '@sausixudos/shared';
import { matchKnownGame } from './gameList.js';

const GAME_POLL_INTERVAL_MS = 12_000;

function activityKey(activity: Activity | null): string {
  if (!activity) return '';
  return activity.kind === 'playing'
    ? `playing:${activity.name}`
    : `listening:${activity.app}:${activity.artist}:${activity.title}`;
}

function toListeningActivity(sessions: readonly MediaSession[]): Activity | null {
  const playing = sessions.find((entry) => entry.playbackStatus === 'playing' && entry.title);
  return playing
    ? {
        kind: 'listening',
        app: playing.sourceAppDisplayName || playing.sourceAppUserModelId,
        title: playing.title ?? '',
        artist: playing.artist ?? '',
      }
    : null;
}

/**
 * Monitora jogo em execução (via lista de processos) e mídia tocando (via
 * GlobalSystemMediaTransportControlsSessionManager do Windows, exposto pelo
 * windows-media-sessions) e chama onChange sempre que a atividade resultante
 * mudar. Jogo tem prioridade sobre mídia quando os dois estão ativos ao
 * mesmo tempo — evita mostrar "ouvindo X" enquanto a pessoa está claramente
 * jogando, que é a informação mais relevante das duas.
 *
 * `log` é opcional só pra não obrigar quem for testar isso fora do Electron
 * a passar um logger — no app de verdade, main.ts sempre passa o debugLog,
 * porque um erro aqui (ex.: o backend nativo não resolvendo o próprio
 * executável dentro do pacote) precisa aparecer em algum lugar em vez de
 * falhar em silêncio sem deixar rastro.
 */
export function startActivityMonitor(
  onChange: (activity: Activity | null) => void,
  log: (message: string) => void = () => {},
): () => void {
  let currentGame: string | null = null;
  let currentMedia: Activity | null = null;
  let lastKey = '';
  let stopped = false;

  const publish = () => {
    const activity: Activity | null = currentGame ? { kind: 'playing', name: currentGame } : currentMedia;
    const key = activityKey(activity);
    if (key === lastKey) return;
    lastKey = key;
    log(`activity changed: ${key || '(nenhuma)'}`);
    onChange(activity);
  };

  const pollGames = async () => {
    if (stopped) return;
    try {
      const processes = await psList();
      currentGame = matchKnownGame(processes.map((entry) => entry.name));
    } catch (error) {
      // Sem lista de processos disponível (permissão negada, etc.) — segue
      // sem detecção de jogo, o resto do app continua funcionando normal.
      log(`pollGames failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      currentGame = null;
    }
    publish();
  };

  void pollGames();
  const gameInterval = setInterval(() => void pollGames(), GAME_POLL_INTERVAL_MS);

  let unsubscribeMedia = () => {};
  try {
    unsubscribeMedia = onSessionsChanged((sessions) => {
      currentMedia = toListeningActivity(sessions);
      publish();
    });
  } catch (error) {
    log(`onSessionsChanged failed to subscribe: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
  // Estado inicial — onSessionsChanged só emite a partir da próxima mudança.
  void getActiveSessions()
    .then((sessions) => {
      currentMedia = toListeningActivity(sessions);
      publish();
    })
    .catch((error: unknown) => {
      // Backend de sessões de mídia indisponível — sem detecção de música,
      // mas a detecção de jogo continua funcionando independentemente.
      log(`getActiveSessions failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    });

  return () => {
    stopped = true;
    clearInterval(gameInterval);
    unsubscribeMedia();
    void shutdownMediaSessions();
  };
}
