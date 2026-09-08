import {
  parseMusicCommand,
  type AuthenticatedUserIdentity,
  type MusicBotCommandRequest,
  type VoiceChannel,
} from '@sausixudos/shared';

export type MusicCommandAuthorizationFailure =
  | 'INVALID_CHANNEL'
  | 'INVALID_COMMAND'
  | 'VOICE_REQUIRED';

export type MusicCommandAuthorizationResult =
  | { ok: true; command: MusicBotCommandRequest }
  | { ok: false; reason: MusicCommandAuthorizationFailure };

interface AuthorizeMusicCommandInput {
  roomId: string;
  text: string;
  channels: readonly VoiceChannel[];
  requester: AuthenticatedUserIdentity;
  listParticipantIdentities: (roomName: string) => Promise<readonly string[]>;
}

/**
 * Constrói o contexto canônico no backend. Nenhum identity, displayName ou
 * roomName fornecido pelo cliente atravessa esta fronteira.
 */
export async function authorizeMusicCommand({
  roomId,
  text,
  channels,
  requester,
  listParticipantIdentities,
}: AuthorizeMusicCommandInput): Promise<MusicCommandAuthorizationResult> {
  const channel = channels.find(({ id }) => id === roomId);
  if (!channel) return { ok: false, reason: 'INVALID_CHANNEL' };

  const parsed = parseMusicCommand(text);
  if (!parsed) return { ok: false, reason: 'INVALID_COMMAND' };

  const participantIdentities = await listParticipantIdentities(channel.id);
  if (!participantIdentities.includes(requester.id)) {
    return { ok: false, reason: 'VOICE_REQUIRED' };
  }

  return {
    ok: true,
    command: {
      channelId: channel.id,
      command: parsed.name,
      args: parsed.args,
      requestedBy: requester,
    } as MusicBotCommandRequest,
  };
}
