import type {
  MusicProvider,
  PlayableMusicSource,
  ResolvedMusicTrack,
} from './musicProvider.js';

const SPOTIFY_HOSTS = new Set(['open.spotify.com', 'www.open.spotify.com']);

interface SpotifyOEmbed {
  title?: string;
  thumbnail_url?: string;
}

interface SpotifyEmbedEntity {
  id?: string;
  title?: string;
  name?: string;
  duration?: number;
  artists?: Array<{ name?: string }>;
  visualIdentity?: { image?: Array<{ url?: string; maxWidth?: number }> };
}

function spotifyId(url: URL): string {
  const parts = url.pathname.split('/').filter(Boolean);
  const index = parts.findIndex((part) => part === 'track');
  return index >= 0 && parts[index + 1] ? parts[index + 1]! : '';
}

function parseEmbedEntity(html: string): SpotifyEmbedEntity | null {
  const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as {
      props?: { pageProps?: { state?: { data?: { entity?: SpotifyEmbedEntity } } } };
    };
    return parsed.props?.pageProps?.state?.data?.entity ?? null;
  } catch {
    return null;
  }
}

function bestImage(entity: SpotifyEmbedEntity): string | undefined {
  const images = entity.visualIdentity?.image?.filter((item) => typeof item.url === 'string') ?? [];
  return [...images].sort((a, b) => (b.maxWidth ?? 0) - (a.maxWidth ?? 0))[0]?.url;
}

function cleanupTitle(value: string): { title: string; author: string } {
  const stripped = value.replace(/\s*\|\s*Spotify\s*$/i, '').trim();
  const match = /^(.*?)\s+-\s+song and lyrics by\s+(.+)$/i.exec(stripped);
  if (match?.[1] && match[2]) return { title: match[1].trim(), author: match[2].trim() };
  return { title: stripped || 'Spotify track', author: 'Spotify' };
}

export class SpotifyProvider implements MusicProvider {
  readonly id = 'spotify';

  constructor(
    private readonly fallback: MusicProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  canHandleUrl(url: URL): boolean {
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      SPOTIFY_HOSTS.has(url.hostname.toLowerCase()) &&
      /\/track\//.test(url.pathname);
  }

  async search(query: string): Promise<ResolvedMusicTrack[]> {
    return this.fallback.search(query);
  }

  async resolveUrl(url: URL): Promise<ResolvedMusicTrack> {
    if (!this.canHandleUrl(url)) throw new Error('URL do Spotify inválida.');
    const id = spotifyId(url);
    if (!id) throw new Error('Não consegui identificar a faixa do Spotify.');

    const embedUrl = `https://open.spotify.com/embed/track/${encodeURIComponent(id)}`;
    const embedResponse = await this.fetchImpl(embedUrl, { signal: AbortSignal.timeout(10_000) });
    if (embedResponse.ok) {
      const entity = parseEmbedEntity(await embedResponse.text());
      if (entity) {
        const author = entity.artists?.map(({ name }) => name).filter(Boolean).join(', ') || 'Spotify';
        return {
          providerId: this.id,
          sourceId: entity.id || id,
          title: entity.title || entity.name || 'Spotify track',
          author,
          durationMs: Number.isFinite(entity.duration) ? Math.max(0, Math.round(entity.duration ?? 0)) : 0,
          webUrl: url.toString(),
          thumbnailUrl: bestImage(entity),
        };
      }
    }

    const endpoint = new URL('https://open.spotify.com/oembed');
    endpoint.searchParams.set('url', url.toString());
    const response = await this.fetchImpl(endpoint, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Spotify metadata falhou (${response.status}).`);
    const data = await response.json() as SpotifyOEmbed;
    const parsed = cleanupTitle(data.title ?? '');
    return {
      providerId: this.id,
      sourceId: id,
      title: parsed.title,
      author: parsed.author,
      durationMs: 0,
      webUrl: url.toString(),
      thumbnailUrl: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : undefined,
    };
  }

  async resolvePlayable(track: ResolvedMusicTrack): Promise<PlayableMusicSource> {
    if (track.providerId !== this.id) throw new Error('Track pertence a outro provider.');
    const query = `${track.title} ${track.author}`.trim();
    const [matched] = await this.fallback.search(query);
    if (!matched) throw new Error('Não encontrei uma fonte pública correspondente para o item do Spotify.');
    return this.fallback.resolvePlayable(matched);
  }
}
