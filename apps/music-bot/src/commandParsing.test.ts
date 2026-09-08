import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isMusicCommandInput, parseMusicCommand } from '@sausixudos/shared';

describe('parseMusicCommand', () => {
  for (const [input, name] of [
    ['/play-file', 'play-file'],
    ['!play-file', 'play-file'],
    ['/play-local', 'play-local'],
    ['!play-local', 'play-local'],
    ['/pause', 'pause'],
    ['!pause', 'pause'],
    ['/resume', 'resume'],
    ['!resume', 'resume'],
    ['/skip', 'skip'],
    ['!skip', 'skip'],
    ['/stop', 'stop'],
    ['!stop', 'stop'],
    ['/leave', 'leave'],
    ['!leave', 'leave'],
    ['/queue', 'queue'],
    ['!queue', 'queue'],
    ['/nowplaying', 'nowplaying'],
    ['!nowplaying', 'nowplaying'],
    ['/np', 'nowplaying'],
    ['!np', 'nowplaying'],
    ['/clear', 'clear'],
    ['!clear', 'clear'],
    ['/history', 'history'],
    ['!history', 'history'],
  ] as const) {
    it(`normaliza ${input}`, () => {
      const parsed = parseMusicCommand(input);
      assert.equal(parsed?.name, name);
      assert.deepEqual(parsed?.args, {});
    });
  }

  for (const volume of [0, 25, 50, 100]) {
    it(`normaliza /volume ${volume}`, () => {
      assert.deepEqual(parseMusicCommand(`/volume ${volume}`), {
        name: 'volume',
        prefix: '/',
        args: { volume },
      });
      assert.deepEqual(parseMusicCommand(`!volume ${volume}`)?.args, { volume });
    });
  }

  it('rejeita volumes inválidos', () => {
    for (const input of ['/volume -1', '/volume 101', '/volume abc', '/volume 1.5', '/volume']) {
      assert.equal(parseMusicCommand(input), null, input);
      assert.equal(isMusicCommandInput(input), true, `${input} ainda deve ser roteado à API`);
    }
  });

  it('aceita /play com busca e URL', () => {
    assert.deepEqual(parseMusicCommand('/play Numb Linkin Park')?.args, { input: 'Numb Linkin Park' });
    assert.deepEqual(parseMusicCommand('!play https://youtu.be/kXYiU_JCYtU')?.args, { input: 'https://youtu.be/kXYiU_JCYtU' });
    assert.equal(isMusicCommandInput('/play Numb Linkin Park'), true);
    assert.equal(parseMusicCommand('/play'), null);
  });

  it('aceita /playlist com URL e exige argumento', () => {
    assert.deepEqual(parseMusicCommand('/playlist https://www.youtube.com/playlist?list=PL123')?.args, {
      input: 'https://www.youtube.com/playlist?list=PL123',
    });
    assert.equal(isMusicCommandInput('/playlist https://www.youtube.com/playlist?list=PL123'), true);
    assert.equal(parseMusicCommand('/playlist'), null);
  });

  it('rejeita argumentos extras e texto comum', () => {
    assert.equal(parseMusicCommand('/pause abc'), null);
    assert.equal(isMusicCommandInput('/pause abc'), true);
    assert.equal(parseMusicCommand('/play-file arquivo.mp3'), null);
    assert.equal(parseMusicCommand('play-file'), null);
  });
});
