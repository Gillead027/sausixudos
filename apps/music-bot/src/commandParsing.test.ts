import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isMusicCommandInput, parseMusicCommand } from '@sausixudos/shared';

describe('parseMusicCommand', () => {
  for (const [input, name] of [
    ['/play-file', 'play-file'],
    ['!play-file', 'play-file'],
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

  it('rejeita argumentos extras, /play externo e texto comum', () => {
    assert.equal(parseMusicCommand('/pause abc'), null);
    assert.equal(isMusicCommandInput('/pause abc'), true);
    assert.equal(parseMusicCommand('/play-file arquivo.mp3'), null);
    assert.equal(parseMusicCommand('/play youtube'), null);
    assert.equal(isMusicCommandInput('/play youtube'), false);
    assert.equal(parseMusicCommand('play-file'), null);
  });
});
