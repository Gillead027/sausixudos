import { nativeImage } from 'electron';
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
// Metadata do participante do LiveKit é transmitido pra sala inteira a cada
// chamada de setMetadata — não dá pra reenviar a cada tick de posição (alguns
// apps disparam TimelinePropertiesChanged a cada segundo). Só republica de
// verdade quando a identidade da faixa muda, quando detecta um seek real
// (posição fugiu da projeção linear esperada) ou a cada
// MEDIA_RESYNC_INTERVAL_MS pra corrigir deriva — no meio disso, quem exibe
// calcula o tempo decorrido localmente a partir da última amostra.
const MEDIA_RESYNC_INTERVAL_MS = 10_000;
const MEDIA_SEEK_THRESHOLD_MS = 3_000;
const THUMBNAIL_SIZE = 96;
const THUMBNAIL_JPEG_QUALITY = 60;

function activityKey(activity: Activity | null): string {
  if (!activity) return '';
  return activity.kind === 'playing'
    ? `playing:${activity.name}`
    : `listening:${activity.app}:${activity.artist}:${activity.title}`;
}

function mediaIdentityKey(activity: Activity | null): string {
  if (!activity || activity.kind !== 'listening') return '';
  return `${activity.app}::${activity.artist}::${activity.title}`;
}

// Reduz a arte do álbum (chega como data URL base64, potencialmente grande)
// pra um thumbnail pequeno via nativeImage — já embutido no Electron, sem
// dependência nova — mantendo o metadata do LiveKit leve independente do
// tamanho original publicado pelo app de origem.
function shrinkThumbnail(dataUrl: string | undefined): string | undefined {
  if (!dataUrl) return undefined;
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return undefined;
    const resized = image.resize({ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, quality: 'good' });
    const jpeg = resized.toJPEG(THUMBNAIL_JPEG_QUALITY);
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  } catch {
    return undefined;
  }
}

function toListeningActivity(sessions: readonly MediaSession[]): Activity | null {
  const playing = sessions.find((entry) => entry.playbackStatus === 'playing' && entry.title);
  if (!playing) return null;

  const thumbnailDataUrl = shrinkThumbnail(playing.thumbnail);
  const positionMs = playing.timeline?.positionMs;
  const durationMs = playing.timeline?.durationMs;
  return {
    kind: 'listening',
    app: playing.sourceAppDisplayName || playing.sourceAppUserModelId,
    title: playing.title ?? '',
    artist: playing.artist ?? '',
    ...(thumbnailDataUrl !== undefined ? { thumbnailDataUrl } : {}),
    ...(positionMs !== undefined ? { positionMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    updatedAt: Date.now(),
  };
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
  let lastMediaIdentityKey = '';
  let lastMediaPublishedAt = 0;
  let stopped = false;

  const publish = (force = false) => {
    const activity: Activity | null = currentGame ? { kind: 'playing', name: currentGame } : currentMedia;
    const key = activityKey(activity);
    if (!force && key === lastKey) return;
    lastKey = key;
    log(`activity changed: ${key || '(nenhuma)'}`);
    onChange(activity);
  };

  // Sempre guarda a amostra mais recente em currentMedia (pra quando o jogo
  // terminar e a mídia assumir de novo), mas só dispara publish() — e o
  // tráfego de rede que isso implica — quando há algo genuinamente novo pra
  // reportar. Ver constantes MEDIA_RESYNC_INTERVAL_MS/MEDIA_SEEK_THRESHOLD_MS.
  const updateMedia = (next: Activity | null) => {
    if (currentGame) {
      currentMedia = next;
      return;
    }
    const identityKey = mediaIdentityKey(next);
    const now = Date.now();
    const identityChanged = identityKey !== lastMediaIdentityKey;

    if (!identityChanged && next?.kind === 'listening' && currentMedia?.kind === 'listening') {
      const elapsedSincePublish = now - lastMediaPublishedAt;
      const projected = (currentMedia.positionMs ?? 0) + elapsedSincePublish;
      const seeked = Math.abs((next.positionMs ?? 0) - projected) > MEDIA_SEEK_THRESHOLD_MS;
      if (!seeked && elapsedSincePublish < MEDIA_RESYNC_INTERVAL_MS) {
        currentMedia = next;
        return;
      }
    }

    lastMediaIdentityKey = identityKey;
    lastMediaPublishedAt = now;
    currentMedia = next;
    publish(true);
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
      updateMedia(toListeningActivity(sessions));
    });
  } catch (error) {
    log(`onSessionsChanged failed to subscribe: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
  // Estado inicial — onSessionsChanged só emite a partir da próxima mudança.
  void getActiveSessions()
    .then((sessions) => {
      updateMedia(toListeningActivity(sessions));
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
