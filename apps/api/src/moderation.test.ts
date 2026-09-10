/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authorizeModerationAction } from './moderation.js';

describe('authorizeModerationAction', () => {
  it('permite agir sobre um membro com posição de cargo menor', () => {
    assert.deepEqual(authorizeModerationAction('mod', 5, 'alvo', 1), { ok: true });
  });

  it('rejeita quando o solicitante tenta agir sobre si mesmo', () => {
    assert.deepEqual(authorizeModerationAction('mod', 5, 'mod', 5), { ok: false, reason: 'SELF' });
  });

  it('rejeita quando o alvo tem posição igual à do solicitante', () => {
    assert.deepEqual(authorizeModerationAction('mod-a', 5, 'mod-b', 5), {
      ok: false,
      reason: 'INSUFFICIENT_RANK',
    });
  });

  it('rejeita quando o alvo tem posição maior que a do solicitante', () => {
    assert.deepEqual(authorizeModerationAction('mod', 1, 'admin', 100), {
      ok: false,
      reason: 'INSUFFICIENT_RANK',
    });
  });

  it('rejeita quando nem o solicitante nem o alvo têm cargo além do @everyone', () => {
    assert.deepEqual(authorizeModerationAction('a', 0, 'b', 0), {
      ok: false,
      reason: 'INSUFFICIENT_RANK',
    });
  });
});
