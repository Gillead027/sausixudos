import type {
  MusicProvider,
  PlayableMusicSource,
  ResolvedMusicTrack,
} from './musicProvider.js';
import { YtDlpClient, type YtDlpMetadata } from './ytDlpClient.js';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

function normalizeMetadata(metadata: YtDlpMetadata): ResolvedMusicTrack {
  const durationMs = Number.isFinite(metadata.duration)
    ? Math.max(0, Math.round((metadata.duration ?? 0) * 1_000))
    : 0;
  return {
    providerId: 'youtube',
    sourceId: metadata.id,
    title: metadata.title,
    author: metadata.uploader?.trim() || 'YouTube',
    durationMs,
    webUrl: metadata.webpage_url,
    thumbnailUrl: metadata.thumbnail,
  };
}

export class YouTubeProvider implements MusicProvider {
  readonly id = 'youtube';

  constructor(private readonly client: Pick<YtDlpClient, 'metadata' | 'playlistMetadata'>) {}

  canHandleUrl(url: URL): boolean {
    return (url.protocol === 'https:' || url.protocol === 'http:') && YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
  }
  async search(query: string): Promise<ResolvedMusicTrack[]> {
    const metadata = await this.client.metadata(`ytsearch1:${query}`);
    return [normalizeMetadata(metadata)];
  }

  async resolveUrl(url: URL): Promise<ResolvedMusicTrack> {
    if (!this.canHandleUrl(url)) throw new Error('URL do YouTube inválida.');
    return normalizeMetadata(await this.client.metadata(url.toString()));
  }

  async resolvePlayable(track: ResolvedMusicTrack): Promise<PlayableMusicSource> {
    if (track.providerId !== this.id) throw new Error('Track pertence a outro provider.');
    return { input: track.webUrl, providerId: this.id, transport: 'YTDLP_PIPE' };
  }

  async resolvePlaylist(url: URL): Promise<ResolvedMusicTrack[]> {
    if (!this.canHandleUrl(url)) throw new Error('URL de playlist do YouTube inválida.');
    if (!url.searchParams.get('list')) throw new Error('A URL não contém uma playlist do YouTube.');
    return (await this.client.playlistMetadata(url.toString(), 50)).map(normalizeMetadata);
  }
}
