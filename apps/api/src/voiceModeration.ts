import type { VoiceChannel } from '@sausixudos/shared';

export type VoiceDisconnectAuthorization =
  | { ok: true }
  | { ok: false; reason: 'INVALID_ROOM' | 'REQUESTER_NOT_IN_ROOM' | 'TARGET_NOT_IN_ROOM' };

export function authorizeVoiceDisconnect({
  roomId,
  channels,
  requesterId,
  targetIdentity,
  participantIdentities,
}: {
  roomId: string;
  channels: readonly VoiceChannel[];
  requesterId: string;
  targetIdentity: string;
  participantIdentities: readonly string[];
}): VoiceDisconnectAuthorization {
  if (!channels.some((channel) => channel.id === roomId)) {
    return { ok: false, reason: 'INVALID_ROOM' };
  }

  const identities = new Set(participantIdentities);
  if (!identities.has(requesterId)) {
    return { ok: false, reason: 'REQUESTER_NOT_IN_ROOM' };
  }

  if (!identities.has(targetIdentity)) {
    return { ok: false, reason: 'TARGET_NOT_IN_ROOM' };
  }

  return { ok: true };
}
