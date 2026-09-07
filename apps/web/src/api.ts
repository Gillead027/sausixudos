import type {
  AccentColor,
  LiveKitTokenResponse,
  PublicConfig,
  RoomSummary,
  UserSession,
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
  sendMusicCommand: (roomId: string, text: string) =>
    request<void>('/api/music/command', {
      method: 'POST',
      body: JSON.stringify({ roomId, text }),
    }),
  getConfig: () => request<PublicConfig>('/api/config'),
  getRooms: () =>
    request<{ rooms: RoomSummary[]; livekitAvailable: boolean }>('/api/rooms'),
  getLiveKitToken: (roomId: string) =>
    request<LiveKitTokenResponse>('/api/livekit/token', {
      method: 'POST',
      body: JSON.stringify({ roomId }),
    }),
};
