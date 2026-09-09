import type {
  AccentColor,
  LiveKitTokenResponse,
  MusicCommandResponse,
  PublicConfig,
  RoomSummary,
  TextChannel,
  TextMessage,
  UserSession,
  VoiceChannel,
} from '@sausixudos/shared';

interface ApiErrorBody {
  error?: string;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    throw new Error(body.error || `Falha na requisição (${response.status}).`);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  getSession: () => request<{ user: UserSession }>('/api/session'),
  register: (username: string, password: string, inviteToken: string, accentColor: AccentColor) =>
    request<{ user: UserSession }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, inviteToken, accentColor }),
    }),
  login: (username: string, password: string) =>
    request<{ user: UserSession }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  deleteSession: () => request<void>('/api/session', { method: 'DELETE' }),
  updateProfile: (
    accentColor: AccentColor,
    statusText: string,
    bio: string,
    pronouns: string,
    avatarUrl: string,
    bannerUrl: string,
  ) =>
    request<{ user: UserSession }>('/api/profile', {
      method: 'PATCH',
      body: JSON.stringify({ accentColor, statusText, bio, pronouns, avatarUrl, bannerUrl }),
    }),
  getUserAvatar: (userId: string) => request<{ avatarUrl: string }>(`/api/users/${userId}/avatar`),
  getUserProfile: (userId: string) => request<{ user: UserSession }>(`/api/users/${userId}/profile`),
  sendMusicCommand: (roomId: string, text: string, textChannelId?: string) =>
    request<MusicCommandResponse>('/api/music/command', {
      method: 'POST',
      body: JSON.stringify({ roomId, text, ...(textChannelId ? { textChannelId } : {}) }),
    }),
  getConfig: () => request<PublicConfig>('/api/config'),
  getRooms: () =>
    request<{ rooms: RoomSummary[]; livekitAvailable: boolean }>('/api/rooms'),
  disconnectVoiceParticipant: (roomId: string, identity: string) =>
    request<void>(`/api/rooms/${encodeURIComponent(roomId)}/participants/${encodeURIComponent(identity)}/disconnect`, {
      method: 'POST',
    }),
  getTextChannels: () => request<{ channels: TextChannel[] }>('/api/text-channels'),
  createTextChannel: (name: string, description: string) =>
    request<{ channel: TextChannel }>('/api/text-channels', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),
  createVoiceChannel: (name: string, description: string) =>
    request<{ channel: VoiceChannel }>('/api/voice-channels', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),
  deleteVoiceChannel: (channelId: string) =>
    request<void>(`/api/voice-channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' }),
  getTextMessages: (channelId: string) =>
    request<{ messages: TextMessage[] }>(`/api/text-channels/${encodeURIComponent(channelId)}/messages`),
  sendTextMessage: (channelId: string, text: string) =>
    request<{ message: TextMessage }>(`/api/text-channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  editTextMessage: (channelId: string, messageId: string, text: string) =>
    request<{ message: TextMessage }>(
      `/api/text-channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      { method: 'PATCH', body: JSON.stringify({ text }) },
    ),
  deleteTextMessage: (channelId: string, messageId: string) =>
    request<void>(`/api/text-channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    }),
  getLiveKitToken: (roomId: string) =>
    request<LiveKitTokenResponse>('/api/livekit/token', {
      method: 'POST',
      body: JSON.stringify({ roomId }),
    }),
};
