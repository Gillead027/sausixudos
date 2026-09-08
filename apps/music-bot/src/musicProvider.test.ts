import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MusicProviderRegistry } from './musicProvider.js';
import { YouTubeProvider } from './youtubeProvider.js';
import { SoundCloudProvider } from './soundcloudProvider.js';

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

describe('fallback resiliente YouTube -> SoundCloud', () => {
  it('usa SoundCloud quando a busca do YouTube é bloqueada', async () => {
    const blockedClient = {
      metadata: async () => { throw new Error('Sign in to confirm you’re not a bot'); },
      playlistMetadata: async () => [],
    };
    const soundcloudClient = {
      metadata: async () => ({
        id: 'sc123', title: 'Numb', uploader: 'LINKIN PARK', duration: 30,
        webpage_url: 'https://soundcloud.com/linkinpark/numb', thumbnail: undefined,
      }),
      playlistMetadata: async () => [],
    };
    const youtube = new YouTubeProvider(blockedClient);
    const soundcloud = new SoundCloudProvider(soundcloudClient);
    const registry = new MusicProviderRegistry([youtube, soundcloud], 'youtube', ['youtube', 'soundcloud']);

    const track = await registry.resolveInput('Numb Linkin Park');
    assert.equal(track.providerId, 'soundcloud');
    assert.equal(track.title, 'Numb');
  });

  it('resolve URL do YouTube por oEmbed e usa SoundCloud como áudio de fallback', async () => {
    const blockedClient = {
      metadata: async () => { throw new Error('youtube bloqueado'); },
      playlistMetadata: async () => [],
    };
    const soundcloudClient = {
      metadata: async () => ({
        id: 'sc456', title: 'Numb', uploader: 'LINKIN PARK', duration: 30,
        webpage_url: 'https://soundcloud.com/linkinpark/numb', thumbnail: undefined,
      }),
      playlistMetadata: async () => [],
    };
    const soundcloud = new SoundCloudProvider(soundcloudClient);
    const fakeFetch = async () => new Response(JSON.stringify({
      title: 'Numb (Official Music Video)',
      author_name: 'Linkin Park',
      thumbnail_url: 'https://i.ytimg.com/vi/kXYiU_JCYtU/hqdefault.jpg',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const youtube = new YouTubeProvider(blockedClient, soundcloud, true, fakeFetch as typeof fetch);
    const registry = new MusicProviderRegistry([youtube, soundcloud], 'youtube', ['youtube', 'soundcloud']);

    const track = await registry.resolveInput('https://www.youtube.com/watch?v=kXYiU_JCYtU');
    assert.equal(track.providerId, 'youtube');
    assert.match(track.title, /Numb/i);
    const playable = await registry.resolvePlayable(track);
    assert.equal(playable.providerId, 'soundcloud');
    assert.equal(playable.input, 'https://soundcloud.com/linkinpark/numb');
  });
});

