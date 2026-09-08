import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MusicProviderRegistry } from './musicProvider.js';
import { YouTubeProvider } from './youtubeProvider.js';

const searchMeta = {
  id: 'abc123',
  title: 'Numb',
  uploader: 'Linkin Park',
  duration: 187,
  webpage_url: 'https://www.youtube.com/watch?v=abc123',
  thumbnail: 'https://i.ytimg.com/vi/abc123/maxresdefault.jpg',
};

function createRegistry() {
  const calls: string[] = [];
  const client = {
    metadata: async (input: string) => {
      calls.push(`metadata:${input}`);
      return searchMeta;
    },
    playlistMetadata: async () => [searchMeta, { ...searchMeta, id: 'def456', title: 'In the End', webpage_url: 'https://www.youtube.com/watch?v=def456' }],
  };
  return {
    calls,
    registry: new MusicProviderRegistry([new YouTubeProvider(client)], 'youtube'),
  };
}

describe('MusicProviderRegistry + YouTubeProvider', () => {
  it('resolve busca textual pelo provider padrão', async () => {
    const { registry, calls } = createRegistry();
    const track = await registry.resolveInput('Numb Linkin Park');
    assert.equal(track.providerId, 'youtube');
    assert.equal(track.title, 'Numb');
    assert.equal(track.author, 'Linkin Park');
    assert.equal(track.durationMs, 187_000);
    assert.deepEqual(calls, ['metadata:ytsearch1:Numb Linkin Park']);
  });

  it('resolve URL direta do YouTube sem busca textual', async () => {
    const { registry, calls } = createRegistry();
    const track = await registry.resolveInput('https://youtu.be/abc123');
    assert.equal(track.sourceId, 'abc123');
    assert.deepEqual(calls, ['metadata:https://youtu.be/abc123']);
  });

  it('resolve fonte reproduzível apenas na hora do playback', async () => {
    const { registry, calls } = createRegistry();
    const track = await registry.resolveInput('Numb Linkin Park');
    assert.equal(calls.length, 1);
    const playable = await registry.resolvePlayable(track);
    assert.equal(playable.input, track.webUrl);
    assert.equal(playable.transport, 'YTDLP_PIPE');
    assert.equal(calls.length, 1);
  });

  it('importa playlist suportada e limita no registry', async () => {
    const { registry } = createRegistry();
    const tracks = await registry.resolvePlaylistInput('https://www.youtube.com/playlist?list=PL123');
    assert.equal(tracks.length, 2);
    assert.equal(tracks[0]?.title, 'Numb');
    assert.equal(tracks[1]?.title, 'In the End');
  });

  it('rejeita URL de provider não suportado', async () => {
    const { registry } = createRegistry();
    await assert.rejects(registry.resolveInput('https://example.com/audio'), /Nenhum provider suporta/);
  });
});
