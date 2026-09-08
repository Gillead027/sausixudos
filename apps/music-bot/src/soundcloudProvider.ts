import type { MusicProvider, PlayableMusicSource, ResolvedMusicTrack } from './musicProvider.js';
import { YtDlpClient, type YtDlpMetadata } from './ytDlpClient.js';

const SOUNDCLOUD_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com']);

function normalizeMetadata(metadata: YtDlpMetadata): ResolvedMusicTrack {
  const durationMs = Number.isFinite(metadata.duration)
    ? Math.max(0, Math.round((metadata.duration ?? 0) * 1_000))
    : 0;
  return {
    providerId: 'soundcloud',
    sourceId: metadata.id,
    title: metadata.title,
    author: metadata.uploader?.trim() || 'SoundCloud',
    durationMs,
    webUrl: metadata.webpage_url,
    thumbnailUrl: metadata.thumbnail,
  };
}

export class SoundCloudProvider implements MusicProvider {
  readonly id = 'soundcloud';

  constructor(private readonly client: Pick<YtDlpClient, 'metadata' | 'playlistMetadata'>) {}

  canHandleUrl(url: URL): boolean {
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      SOUNDCLOUD_HOSTS.has(url.hostname.toLowerCase());
  }

  async search(query: string): Promise<ResolvedMusicTrack[]> {
    const metadata = await this.client.metadata(`scsearch1:${query}`);
    return [normalizeMetadata(metadata)];
  }

  async resolveUrl(url: URL): Promise<ResolvedMusicTrack> {
    if (!this.canHandleUrl(url)) throw new Error('URL do SoundCloud inválida.');
    return normalizeMetadata(await this.client.metadata(url.toString()));
  }

  async resolvePlayable(track: ResolvedMusicTrack): Promise<PlayableMusicSource> {
    if (track.providerId !== this.id) throw new Error('Track pertence a outro provider.');
    return { input: track.webUrl, providerId: this.id, transport: 'YTDLP_PIPE' };
  }

  async resolvePlaylist(url: URL): Promise<ResolvedMusicTrack[]> {
    if (!this.canHandleUrl(url) || !/\/sets\//i.test(url.pathname)) {
      throw new Error('Informe uma URL de playlist do SoundCloud.');
    }
    return (await this.client.playlistMetadata(url.toString(), 50)).map(normalizeMetadata);
  }
}
