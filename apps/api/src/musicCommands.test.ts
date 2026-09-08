import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authorizeMusicCommand } from './musicCommands.js';

const channels = [{ id: 'geral', name: 'Geral', description: 'Conversa livre' }];
const requester = { id: 'user-canonical', displayName: 'Gillezin' };

describe('authorizeMusicCommand', () => {
  it('cria contexto apenas com room e identidade canônicas', async () => {
    const result = await authorizeMusicCommand({
      roomId: 'geral',
      text: '!play-file',
      channels,
      requester,
      listParticipantIdentities: async (roomName) => {
        assert.equal(roomName, 'geral');
        return ['user-canonical'];
      },
    });

    assert.deepEqual(result, {
      ok: true,
      command: {
        channelId: 'geral',
        command: 'play-file',
        args: {},
        requestedBy: requester,
      },
    });
  });

  it('encaminha argumentos de volume já normalizados pelo parser compartilhado', async () => {
    const result = await authorizeMusicCommand({
      roomId: 'geral',
      text: '!volume 25',
      channels,
      requester,
      listParticipantIdentities: async () => ['user-canonical'],
    });

    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.equal(result.command.command, 'volume');
    assert.deepEqual(result.command.args, { volume: 25 });
  });

  it('rejeita room não configurada antes de consultar o LiveKit', async () => {
    let queried = false;
    const result = await authorizeMusicCommand({
      roomId: 'room-injetada',
      text: '/play-file',
      channels,
      requester,
      listParticipantIdentities: async () => {
        queried = true;
        return ['user-canonical'];
      },
    });

    assert.deepEqual(result, { ok: false, reason: 'INVALID_CHANNEL' });
    assert.equal(queried, false);
  });

  it('rejeita usuário que não está na sala solicitada', async () => {
    const result = await authorizeMusicCommand({
      roomId: 'geral',
      text: '/stop',
      channels,
      requester,
      listParticipantIdentities: async () => ['outro-usuario'],
    });

    assert.deepEqual(result, { ok: false, reason: 'VOICE_REQUIRED' });
  });
});
