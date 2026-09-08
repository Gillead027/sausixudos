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

interface YouTubeOEmbed {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}

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

function youtubeVideoId(url: URL): string {
  if (url.hostname.toLowerCase() === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] ?? '';
  return url.searchParams.get('v') ?? '';
}

export class YouTubeProvider implements MusicProvider {
  readonly id = 'youtube';

  constructor(
    private readonly client: Pick<YtDlpClient, 'metadata' | 'playlistMetadata'>,
    private readonly audioFallback?: MusicProvider,
    private readonly preferAudioFallback = false,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  canHandleUrl(url: URL): boolean {
    return (url.protocol === 'https:' || url.protocol === 'http:') && YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
  }

  async search(query: string): Promise<ResolvedMusicTrack[]> {
    const metadata = await this.client.metadata(`ytsearch1:${query}`);
    return [normalizeMetadata(metadata)];
  }

  async resolveUrl(url: URL): Promise<ResolvedMusicTrack> {
    if (!this.canHandleUrl(url)) throw new Error('URL do YouTube inválida.');
    try {
      return normalizeMetadata(await this.client.metadata(url.toString()));
    } catch (primaryError) {
      const endpoint = new URL('https://www.youtube.com/oembed');
      endpoint.searchParams.set('url', url.toString());
      endpoint.searchParams.set('format', 'json');
      const response = await this.fetchImpl(endpoint, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw primaryError;
      const data = await response.json() as YouTubeOEmbed;
      return {
        providerId: this.id,
        sourceId: youtubeVideoId(url) || url.toString(),
        title: data.title?.trim() || 'YouTube',
        author: data.author_name?.trim() || 'YouTube',
        durationMs: 0,
        webUrl: url.toString(),
        thumbnailUrl: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : undefined,
      };
    }
  }

  async resolvePlayable(track: ResolvedMusicTrack): Promise<PlayableMusicSource> {
    if (track.providerId !== this.id) throw new Error('Track pertence a outro provider.');
    if (this.preferAudioFallback && this.audioFallback) {
      try {
        const [matched] = await this.audioFallback.search(`${track.title} ${track.author}`.trim());
        if (matched) return this.audioFallback.resolvePlayable(matched);
      } catch {
        // Se o fallback também falhar, ainda tentamos a URL original do YouTube.
      }
    }
    return { input: track.webUrl, providerId: this.id, transport: 'YTDLP_PIPE' };
  }

  async resolvePlaylist(url: URL): Promise<ResolvedMusicTrack[]> {
    if (!this.canHandleUrl(url)) throw new Error('URL de playlist do YouTube inválida.');
    if (!url.searchParams.get('list')) throw new Error('A URL não contém uma playlist do YouTube.');
    return (await this.client.playlistMetadata(url.toString(), 50)).map(normalizeMetadata);
  }
}
