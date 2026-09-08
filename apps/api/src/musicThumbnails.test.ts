/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchMusicThumbnail, parseAllowedMusicThumbnailUrl } from './musicThumbnails.js';

describe('music thumbnails', () => {
  it('aceita apenas CDNs HTTPS conhecidos', () => {
    assert.equal(parseAllowedMusicThumbnailUrl('https://i1.sndcdn.com/artworks-test.jpg')?.hostname, 'i1.sndcdn.com');
    assert.equal(parseAllowedMusicThumbnailUrl('https://i.ytimg.com/vi/test/hqdefault.jpg')?.hostname, 'i.ytimg.com');
    assert.equal(parseAllowedMusicThumbnailUrl('http://i1.sndcdn.com/artworks-test.jpg'), null);
    assert.equal(parseAllowedMusicThumbnailUrl('https://sndcdn.com.evil.example/image.jpg'), null);
  });

  it('faz proxy somente de respostas de imagem', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const fakeFetch = async () => new Response(payload, {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(payload.byteLength) },
    });
    const result = await fetchMusicThumbnail('https://i1.sndcdn.com/artworks-test.jpg', fakeFetch as typeof fetch);
    assert.equal(result.contentType, 'image/jpeg');
    assert.deepEqual(Array.from(result.body), Array.from(payload));
  });
});
