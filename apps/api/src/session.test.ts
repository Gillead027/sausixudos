import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Response } from 'express';
import { createSession, getSessionFromCookieHeader, setSessionCookie } from './session.js';

// getSessionFromCookieHeader é o que autentica o handshake do WebSocket (ver
// apps/api/src/realtime.ts), que não passa pelo middleware do Express e por
// isso não tem um objeto Request pronto — só o header bruto de cookie.
function cookieHeaderFor(id: string, displayName: string): string {
  let cookieValue = '';
  const fakeResponse = {
    cookie: (_name: string, value: string) => {
      cookieValue = value;
    },
  } as unknown as Response;
  setSessionCookie(fakeResponse, createSession(id, displayName));
  return `sausixudos_session=${cookieValue}`;
}

describe('getSessionFromCookieHeader', () => {
  it('aceita um cookie de sessão recém-criado', () => {
    const header = cookieHeaderFor('user-1', 'Alice');
    assert.deepEqual(getSessionFromCookieHeader(header), { id: 'user-1', displayName: 'Alice' });
  });

  it('rejeita quando não há header de cookie', () => {
    assert.equal(getSessionFromCookieHeader(undefined), null);
  });

  it('rejeita quando o cookie de sessão está ausente entre outros cookies', () => {
    assert.equal(getSessionFromCookieHeader('outro=valor; tema=escuro'), null);
  });

  it('rejeita uma assinatura adulterada', () => {
    const header = cookieHeaderFor('user-1', 'Alice');
    const [name, value] = header.split('=');
    const [payload] = value?.split('.') ?? [];
    assert.equal(getSessionFromCookieHeader(`${name}=${payload}.assinatura-forjada`), null);
  });

  it('rejeita um payload corrompido mesmo com o formato certo', () => {
    assert.equal(getSessionFromCookieHeader('sausixudos_session=YQ.YQ'), null);
  });
});
