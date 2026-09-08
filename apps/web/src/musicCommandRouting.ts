import { isMusicCommandInput, type MusicCommandResponse } from '@sausixudos/shared';

interface MusicCommandRoute {
  text: string;
  voiceChannelId: string | null;
  sendMusicCommand: (voiceChannelId: string, text: string) => Promise<MusicCommandResponse>;
}

function requireVoiceChannel(voiceChannelId: string | null): string {
  if (!voiceChannelId) {
    throw new Error('Você precisa estar em um canal de voz para usar este comando.');
  }
  return voiceChannelId;
}

async function routeMusicCommand({
  text,
  voiceChannelId,
  sendMusicCommand,
}: MusicCommandRoute): Promise<MusicCommandResponse | null> {
  if (!isMusicCommandInput(text)) return null;
  const channelId = requireVoiceChannel(voiceChannelId);
  console.info(`[WEB] music command detected channel=${channelId}`);
  return sendMusicCommand(channelId, text);
}

export async function routeTextChannelInput<T>({
  text,
  voiceChannelId,
  sendMusicCommand,
  sendTextMessage,
}: MusicCommandRoute & {
  sendTextMessage: (text: string) => Promise<T>;
}): Promise<
  | { kind: 'music-command'; response: MusicCommandResponse }
  | { kind: 'text-message'; message: T }
> {
  const response = await routeMusicCommand({ text, voiceChannelId, sendMusicCommand });
  if (response) return { kind: 'music-command', response };
  return { kind: 'text-message', message: await sendTextMessage(text) };
}

export async function routeVoiceChatInput({
  text,
  voiceChannelId,
  sendMusicCommand,
  publishChatMessage,
}: MusicCommandRoute & {
  publishChatMessage: (text: string) => Promise<void>;
}): Promise<
  | { kind: 'music-command'; response: MusicCommandResponse }
  | { kind: 'voice-message' }
> {
  const response = await routeMusicCommand({ text, voiceChannelId, sendMusicCommand });
  if (response) return { kind: 'music-command', response };
  await publishChatMessage(text);
  return { kind: 'voice-message' };
}
