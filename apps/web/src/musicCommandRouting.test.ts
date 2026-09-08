/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { routeTextChannelInput, routeVoiceChatInput } from './musicCommandRouting.js';

describe('roteamento do composer de canal de texto', () => {
  it('encaminha /play-file somente para a API de música', async () => {
    const calls: string[] = [];
    const result = await routeTextChannelInput({
      text: '/play-file',
      voiceChannelId: 'geral',
      textChannelId: 'musica',
      sendMusicCommand: async (channelId, text, textChannelId) => {
        calls.push(`music:${channelId}:${text}:${textChannelId}`);
        return { message: 'SausiMusic recebeu o comando.' };
      },
      sendTextMessage: async (text) => {
        calls.push(`text:${text}`);
        return text;
      },
    });

    assert.equal(result.kind, 'music-command');
    assert.deepEqual(calls, ['music:geral:/play-file:musica']);
  });

  it('encaminha mensagem comum somente para o canal de texto', async () => {
    const calls: string[] = [];
    const result = await routeTextChannelInput({
      text: 'olá',
      voiceChannelId: 'geral',
      sendMusicCommand: async () => {
        calls.push('music');
        return { message: 'não deveria executar' };
      },
      sendTextMessage: async (text) => {
        calls.push(`text:${text}`);
        return text;
      },
    });

    assert.equal(result.kind, 'text-message');
    assert.deepEqual(calls, ['text:olá']);
  });

  it('reconhece !stop como comando musical', async () => {
    const calls: string[] = [];
    await routeTextChannelInput({
      text: '!stop',
      voiceChannelId: 'geral',
      sendMusicCommand: async (_channelId, text) => {
        calls.push(`music:${text}`);
        return { message: 'SausiMusic recebeu o comando.' };
      },
      sendTextMessage: async (text) => {
        calls.push(`text:${text}`);
        return text;
      },
    });

    assert.deepEqual(calls, ['music:!stop']);
  });

  it('encaminha comando conhecido com argumentos inválidos para a validação da API', async () => {
    const calls: string[] = [];
    await assert.rejects(
      routeTextChannelInput({
        text: '/volume abc',
        voiceChannelId: 'geral',
        sendMusicCommand: async (_channelId, text) => {
          calls.push(`music:${text}`);
          throw new Error('Comando musical ou canal inválido.');
        },
        sendTextMessage: async (text) => {
          calls.push(`text:${text}`);
          return text;
        },
      }),
      /Comando musical ou canal inválido/,
    );
    assert.deepEqual(calls, ['music:/volume abc']);
  });

  it('explica que comandos exigem um canal de voz, sem usar o canal de texto', async () => {
    await assert.rejects(
      routeTextChannelInput({
        text: '!leave',
        voiceChannelId: null,
        sendMusicCommand: async () => ({ message: 'não deveria executar' }),
        sendTextMessage: async (text) => text,
      }),
      /Você precisa estar em um canal de voz para usar este comando\./,
    );
  });
});

describe('roteamento do composer do chat de voz', () => {
  it('encaminha /play-file somente para a API de música', async () => {
    const calls: string[] = [];
    const result = await routeVoiceChatInput({
      text: '/play-file',
      voiceChannelId: 'geral',
      sendMusicCommand: async (channelId, text) => {
        calls.push(`music:${channelId}:${text}`);
        return { message: 'SausiMusic recebeu o comando.' };
      },
      publishChatMessage: async (text) => {
        calls.push(`data:${text}`);
      },
    });

    assert.equal(result.kind, 'music-command');
    assert.deepEqual(calls, ['music:geral:/play-file']);
  });

  it('publica mensagem comum somente pelo LiveKit Data', async () => {
    const calls: string[] = [];
    const result = await routeVoiceChatInput({
      text: 'mensagem comum',
      voiceChannelId: 'geral',
      sendMusicCommand: async () => {
        calls.push('music');
        return { message: 'não deveria executar' };
      },
      publishChatMessage: async (text) => {
        calls.push(`data:${text}`);
      },
    });

    assert.equal(result.kind, 'voice-message');
    assert.deepEqual(calls, ['data:mensagem comum']);
  });
});
