const ALLOWED_THUMBNAIL_HOST_SUFFIXES = [
  'ytimg.com',
  'sndcdn.com',
  'spotifycdn.com',
  'scdn.co',
] as const;

const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

function hostMatches(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export function parseAllowedMusicThumbnailUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    const hostname = url.hostname.toLowerCase();
    return ALLOWED_THUMBNAIL_HOST_SUFFIXES.some((suffix) => hostMatches(hostname, suffix))
      ? url
      : null;
  } catch {
    return null;
  }
}
export interface MusicThumbnailPayload {
  contentType: string;
  body: Uint8Array;
}

export async function fetchMusicThumbnail(
  value: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MusicThumbnailPayload> {
  let url = parseAllowedMusicThumbnailUrl(value);
  if (!url) throw new Error('Thumbnail não permitido.');

  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Sausixudos/1.0' },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirecionamento de thumbnail inválido.');
      url = parseAllowedMusicThumbnailUrl(new URL(location, url).toString());
      if (!url) throw new Error('Redirecionamento de thumbnail não permitido.');
      continue;
    }
    if (!response.ok) throw new Error(`Thumbnail indisponível (${response.status}).`);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!contentType.startsWith('image/')) throw new Error('Resposta de thumbnail não é uma imagem.');

    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_THUMBNAIL_BYTES) {
      throw new Error('Thumbnail excede o tamanho permitido.');
    }

    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_THUMBNAIL_BYTES) throw new Error('Thumbnail excede o tamanho permitido.');
    return { contentType, body };
  }

  throw new Error('Muitos redirecionamentos de thumbnail.');
}
