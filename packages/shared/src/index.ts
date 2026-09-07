export const DISPLAY_NAME_MIN_LENGTH = 2;
export const DISPLAY_NAME_MAX_LENGTH = 24;
export const CHAT_MESSAGE_MAX_LENGTH = 500;
export const TEXT_CHANNEL_NAME_MAX_LENGTH = 32;
export const TEXT_CHANNEL_DESCRIPTION_MAX_LENGTH = 120;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;
export const STATUS_TEXT_MAX_LENGTH = 60;
export const BIO_MAX_LENGTH = 300;
export const PRONOUNS_MAX_LENGTH = 30;
export const AVATAR_DATA_URL_MAX_LENGTH = 400_000;
export const BANNER_DATA_URL_MAX_LENGTH = 1_100_000;

export const ACCENT_COLORS = [
  '#4e7960',
  '#5c526b',
  '#566747',
  '#6b5548',
  '#45645f',
  '#684d52',
  '#4a6b8a',
  '#8a5a4a',
] as const;

export type AccentColor = (typeof ACCENT_COLORS)[number];

export interface UserSession {
  id: string;
  displayName: string;
  accentColor: AccentColor;
  statusText: string;
  bio: string;
  pronouns: string;
  avatarUrl: string;
  bannerUrl: string;
}

export interface VoiceChannel {
  id: string;
  name: string;
  description: string;
}

export interface RoomParticipantSummary {
  identity: string;
  name: string;
  isSharingScreen: boolean;
}

export interface RoomSummary extends VoiceChannel {
  participants: RoomParticipantSummary[];
}

export interface PublicConfig {
  livekitUrl: string;
  channels: VoiceChannel[];
}

export interface LiveKitTokenResponse {
  token: string;
  url: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: number;
}

export interface TextChannel {
  id: string;
  name: string;
  description: string;
  createdBy: string | null;
  createdAt: number;
}

export interface TextMessage {
  id: string;
  channelId: string;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: number;
}
