import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MusicProvider } from './musicProvider.js';
import { SpotifyProvider } from './spotifyProvider.js';

const fallbackTrack = {
  providerId: 'youtube', sourceId: 'yt1', title: 'Numb', author: 'Linkin Park',
  durationMs: 187_000, webUrl: 'https://youtube.com/watch?v=yt1', thumbnailUrl: undefined,
};
const fallback: MusicProvider = {
  id: 'youtube',
  canHandleUrl: () => false,
  search: async () => [fallbackTrack],
  resolveUrl: async () => fallbackTrack,
  resolvePlayable: async () => ({ input: fallbackTrack.webUrl, providerId: 'youtube', transport: 'YTDLP_PIPE' }),
};

describe('SpotifyProvider metadata bridge', () => {
  it('lê metadata pública e usa YouTube somente como fonte reproduzível', async () => {
    const fakeFetch = async () => new Response(JSON.stringify({
      title: 'Numb - song and lyrics by Linkin Park | Spotify',
      thumbnail_url: 'https://i.scdn.co/image/test',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const provider = new SpotifyProvider(fallback, fakeFetch as typeof fetch);
    const track = await provider.resolveUrl(new URL('https://open.spotify.com/track/abc123'));
    assert.equal(track.providerId, 'spotify');
    assert.equal(track.title, 'Numb');
    assert.equal(track.author, 'Linkin Park');
    assert.equal(track.thumbnailUrl, 'https://i.scdn.co/image/test');    const playable = await provider.resolvePlayable(track);
    assert.equal(playable.providerId, 'youtube');
    assert.equal(playable.transport, 'YTDLP_PIPE');
  });

  it('rejeita URLs que não são tracks do Spotify', async () => {
    const provider = new SpotifyProvider(fallback, (async () => new Response('{}')) as typeof fetch);
    await assert.rejects(
      provider.resolveUrl(new URL('https://open.spotify.com/album/abc')),
      /URL do Spotify inválida/,
    );
  });
});
