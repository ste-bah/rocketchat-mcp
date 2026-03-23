/**
 * RocketChat REST API Client
 *
 * Handles authentication, channel resolution, DM room creation,
 * and all REST API calls. Caches channel name→roomId mappings
 * and DM roomIds to avoid redundant lookups.
 */

import type {
  AuthState,
  LoginResponse,
  RocketChatMessage,
  RocketChatChannel,
  FormattedMessage,
  FormattedChannel,
  DMCreateResponse,
  ServerConfig,
} from './types.js';

export class RocketChatClient {
  private url: string;
  private config: ServerConfig;
  private auth: AuthState = { userId: '', authToken: '', authenticated: false };

  // Caches: name → roomId
  private channelCache = new Map<string, string>();
  private dmRoomCache = new Map<string, string>();

  constructor(config: ServerConfig) {
    this.config = config;
    // Strip trailing slash from URL
    this.url = config.url.replace(/\/+$/, '');
  }

  // ── Authentication ──

  async login(): Promise<void> {
    // Option 1: Personal access token (preferred, no invalidation on re-login)
    if (this.config.personalAccessToken) {
      this.auth = {
        userId: this.config.personalAccessTokenId || '',
        authToken: this.config.personalAccessToken,
        authenticated: true,
      };
      // Verify the token works
      const res = await this.apiGet('/api/v1/me');
      if (res.ok) {
        const data = await res.json();
        this.auth.userId = data._id;
        console.error(`[rocketchat] Authenticated via personal access token as ${data.username}`);
        return;
      }
      throw new Error('Personal access token authentication failed');
    }

    // Option 2: Password login
    if (!this.config.password) {
      throw new Error('No password or personal access token configured');
    }

    const res = await fetch(`${this.url}/api/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: this.config.user,
        password: this.config.password,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Login failed (${res.status}): ${text}`);
    }

    const data: LoginResponse = await res.json();
    this.auth = {
      userId: data.data.userId,
      authToken: data.data.authToken,
      authenticated: true,
    };
    console.error(`[rocketchat] Authenticated as ${data.data.me.username} (password login)`);
  }

  get isAuthenticated(): boolean {
    return this.auth.authenticated;
  }

  // ── API Helpers ──

  private async apiGet(path: string): Promise<Response> {
    return fetch(`${this.url}${path}`, {
      headers: this.authHeaders(),
    });
  }

  private async apiPost(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  private authHeaders(): Record<string, string> {
    return {
      'X-Auth-Token': this.auth.authToken,
      'X-User-Id': this.auth.userId,
    };
  }

  private async apiCallWithReauth<T>(fn: () => Promise<Response>): Promise<T> {
    let res = await fn();

    // Re-auth on 401
    if (res.status === 401) {
      console.error('[rocketchat] Token expired, re-authenticating...');
      await this.login();
      res = await fn();
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error (${res.status}): ${text.substring(0, 500)}`);
    }

    return res.json() as Promise<T>;
  }

  // ── Channel Resolution (name → roomId) ──

  async resolveChannelId(channelName: string): Promise<string> {
    // Check cache first
    const cached = this.channelCache.get(channelName);
    if (cached) return cached;

    // Try channels.info by name
    const data = await this.apiCallWithReauth<{ channel: RocketChatChannel }>(() =>
      this.apiGet(`/api/v1/channels.info?roomName=${encodeURIComponent(channelName)}`)
    );

    const roomId = data.channel._id;
    this.channelCache.set(channelName, roomId);
    return roomId;
  }

  // ── DM Room Resolution (username → roomId) ──

  async resolveDMRoomId(username: string): Promise<string> {
    // Check cache first
    const cached = this.dmRoomCache.get(username);
    if (cached) return cached;

    // Create or open DM room
    const data = await this.apiCallWithReauth<DMCreateResponse>(() =>
      this.apiPost('/api/v1/im.create', { username })
    );

    const roomId = data.room._id;
    this.dmRoomCache.set(username, roomId);
    return roomId;
  }

  // ── Messages ──

  async sendMessage(roomId: string, text: string): Promise<FormattedMessage> {
    const data = await this.apiCallWithReauth<{ message: RocketChatMessage }>(() =>
      this.apiPost('/api/v1/chat.sendMessage', {
        message: { rid: roomId, msg: text },
      })
    );

    return this.formatMessage(data.message);
  }

  async getMessages(roomId: string, count: number = 20): Promise<FormattedMessage[]> {
    // RocketChat caps at 100 per request
    const safeCount = Math.min(Math.max(1, count), 100);

    const data = await this.apiCallWithReauth<{ messages: RocketChatMessage[] }>(() =>
      this.apiGet(`/api/v1/channels.history?roomId=${roomId}&count=${safeCount}`)
    );

    return (data.messages || []).map(m => this.formatMessage(m));
  }

  async getDMMessages(roomId: string, count: number = 20): Promise<FormattedMessage[]> {
    const safeCount = Math.min(Math.max(1, count), 100);

    const data = await this.apiCallWithReauth<{ messages: RocketChatMessage[] }>(() =>
      this.apiGet(`/api/v1/im.history?roomId=${roomId}&count=${safeCount}`)
    );

    return (data.messages || []).map(m => this.formatMessage(m));
  }

  // ── Channels ──

  async listChannels(): Promise<FormattedChannel[]> {
    const data = await this.apiCallWithReauth<{ channels: RocketChatChannel[] }>(() =>
      this.apiGet('/api/v1/channels.list.joined?count=50')
    );

    const channels = (data.channels || []).map(ch => this.formatChannel(ch));

    // Update cache
    for (const ch of data.channels || []) {
      this.channelCache.set(ch.name, ch._id);
    }

    return channels;
  }

  async getChannelInfo(channelName: string): Promise<FormattedChannel> {
    const data = await this.apiCallWithReauth<{ channel: RocketChatChannel }>(() =>
      this.apiGet(`/api/v1/channels.info?roomName=${encodeURIComponent(channelName)}`)
    );

    this.channelCache.set(data.channel.name, data.channel._id);
    return this.formatChannel(data.channel);
  }

  // ── Search ──

  async searchMessages(
    roomId: string,
    query: string,
    count: number = 20
  ): Promise<FormattedMessage[]> {
    const safeCount = Math.min(Math.max(1, count), 100);

    // Try chat.search first (requires FTS to be enabled)
    try {
      const data = await this.apiCallWithReauth<{ messages: RocketChatMessage[] }>(() =>
        this.apiGet(
          `/api/v1/chat.search?roomId=${roomId}&searchText=${encodeURIComponent(query)}&count=${safeCount}`
        )
      );
      return (data.messages || []).map(m => this.formatMessage(m));
    } catch {
      // Fallback: get recent messages and filter client-side
      console.error('[rocketchat] chat.search failed, falling back to client-side filter');
      const messages = await this.getMessages(roomId, 100);
      const lowerQuery = query.toLowerCase();
      return messages
        .filter(m => m.text.toLowerCase().includes(lowerQuery))
        .slice(0, safeCount);
    }
  }

  // ── Formatters ──

  private formatMessage(msg: RocketChatMessage): FormattedMessage {
    return {
      id: msg._id,
      roomId: msg.rid,
      text: msg.msg,
      timestamp: msg.ts,
      username: msg.u?.username || 'unknown',
      displayName: msg.u?.name || msg.u?.username || 'unknown',
    };
  }

  private formatChannel(ch: RocketChatChannel): FormattedChannel {
    const typeMap: Record<string, FormattedChannel['type']> = {
      c: 'channel',
      p: 'private',
      d: 'dm',
    };
    return {
      id: ch._id,
      name: ch.name,
      type: typeMap[ch.t] || 'unknown',
      messageCount: ch.msgs || 0,
      memberCount: ch.usersCount || 0,
      topic: ch.topic || '',
      description: ch.description || '',
    };
  }
}
