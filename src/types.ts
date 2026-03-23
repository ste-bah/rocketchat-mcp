/**
 * RocketChat MCP Server — Type Definitions
 */

// ── Auth ──

export interface LoginResponse {
  status: string;
  data: {
    userId: string;
    authToken: string;
    me: {
      _id: string;
      username: string;
      name: string;
    };
  };
}

export interface AuthState {
  userId: string;
  authToken: string;
  authenticated: boolean;
}

// ── Messages ──

export interface RocketChatMessage {
  _id: string;
  rid: string;
  msg: string;
  ts: string;
  u: {
    _id: string;
    username: string;
    name?: string;
  };
  _updatedAt?: string;
  mentions?: Array<{ _id: string; username: string }>;
  attachments?: Array<{ title?: string; text?: string }>;
}

export interface FormattedMessage {
  id: string;
  roomId: string;
  text: string;
  timestamp: string;
  username: string;
  displayName: string;
}

// ── Channels ──

export interface RocketChatChannel {
  _id: string;
  name: string;
  t: string; // 'c' = channel, 'p' = private, 'd' = DM
  msgs: number;
  usersCount: number;
  topic?: string;
  description?: string;
}

export interface FormattedChannel {
  id: string;
  name: string;
  type: 'channel' | 'private' | 'dm' | 'unknown';
  messageCount: number;
  memberCount: number;
  topic: string;
  description: string;
}

// ── DM ──

export interface DMCreateResponse {
  room: {
    _id: string;
    usernames: string[];
  };
}

// ── Tool Inputs ──

export interface SendMessageInput {
  channel: string;
  message: string;
}

export interface ReadMessagesInput {
  channel: string;
  limit?: number;
}

export interface DMSendInput {
  username: string;
  message: string;
}

export interface DMReadInput {
  username: string;
  limit?: number;
}

export interface SearchMessagesInput {
  query: string;
  channel?: string;
  limit?: number;
}

export interface GetChannelInfoInput {
  channel: string;
}

// ── Config ──

export interface ServerConfig {
  url: string;
  user: string;
  password?: string;
  personalAccessToken?: string;
  personalAccessTokenId?: string;
}
