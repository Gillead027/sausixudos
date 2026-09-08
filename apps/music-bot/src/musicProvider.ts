export interface ResolvedMusicTrack {
  providerId: string;
  sourceId: string;
  title: string;
  author: string;
  durationMs: number;
  webUrl: string;
  thumbnailUrl: string | undefined;
}

export interface PlayableMusicSource {
  input: string;
  providerId: string;
  transport: 'YTDLP_PIPE';
}

export interface MusicProvider {
  readonly id: string;
  canHandleUrl(url: URL): boolean;
  search(query: string): Promise<ResolvedMusicTrack[]>;
  resolveUrl(url: URL): Promise<ResolvedMusicTrack>;
  resolvePlayable(track: ResolvedMusicTrack): Promise<PlayableMusicSource>;
  resolvePlaylist?(url: URL): Promise<ResolvedMusicTrack[]>;
}

export class MusicProviderRegistry {
  private readonly byId = new Map<string, MusicProvider>();

  constructor(
    providers: readonly MusicProvider[],
    private readonly defaultProviderId: string,
  ) {
    for (const provider of providers) this.byId.set(provider.id, provider);
    if (!this.byId.has(defaultProviderId)) {
      throw new Error(`Provider padrão não registrado: ${defaultProviderId}`);
    }
  }
  async resolveInput(input: string): Promise<ResolvedMusicTrack> {
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(input);
    } catch {
      parsedUrl = null;
    }

    if (parsedUrl) {
      const provider = Array.from(this.byId.values()).find((item) => item.canHandleUrl(parsedUrl!));
      if (!provider) throw new Error('Nenhum provider suporta esta URL.');
      return provider.resolveUrl(parsedUrl);
    }

    const provider = this.byId.get(this.defaultProviderId);
    if (!provider) throw new Error('Provider padrão indisponível.');
    const [first] = await provider.search(input);
    if (!first) throw new Error('Nenhum resultado encontrado.');
    return first;
  }

  async resolvePlayable(track: ResolvedMusicTrack): Promise<PlayableMusicSource> {
    const provider = this.byId.get(track.providerId);
    if (!provider) throw new Error(`Provider não registrado: ${track.providerId}`);
    return provider.resolvePlayable(track);
  }

  async resolvePlaylistInput(input: string): Promise<ResolvedMusicTrack[]> {
    let url: URL;
    try { url = new URL(input); } catch { throw new Error('Informe uma URL de playlist suportada.'); }
    const provider = Array.from(this.byId.values()).find((item) => item.canHandleUrl(url));
    if (!provider?.resolvePlaylist) throw new Error('Este provider não oferece importação de playlist.');
    const tracks = await provider.resolvePlaylist(url);
    if (tracks.length === 0) throw new Error('A playlist não possui faixas reproduzíveis.');
    return tracks.slice(0, 50);
  }
}
