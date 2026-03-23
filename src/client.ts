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

  // Caches: name → {roomId, type}
  private channelCache = new Map<string, { roomId: string; type: 'c' | 'p' }>();
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

    // Re-auth on 401 (only for password auth — PAT tokens can't be refreshed)
    if (res.status === 401) {
      if (this.config.personalAccessToken) {
        throw new Error('Personal access token rejected (401). Token may be revoked.');
      }
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

  // ── Channel Resolution (name → roomId, handles public + private) ──

  async resolveChannelId(channelName: string): Promise<string> {
    // Check cache first
    const cached = this.channelCache.get(channelName);
    if (cached) return cached.roomId;

    // Try public channel first (channels.info)
    try {
      const data = await this.apiCallWithReauth<{ channel: RocketChatChannel }>(() =>
        this.apiGet(`/api/v1/channels.info?roomName=${encodeURIComponent(channelName)}`)
      );
      const roomId = data.channel._id;
      this.channelCache.set(channelName, { roomId, type: 'c' });
      return roomId;
    } catch {
      // Not a public channel, try private group
    }

    // Try private group (groups.info)
    try {
      const data = await this.apiCallWithReauth<{ group: RocketChatChannel }>(() =>
        this.apiGet(`/api/v1/groups.info?roomName=${encodeURIComponent(channelName)}`)
      );
      const roomId = data.group._id;
      this.channelCache.set(channelName, { roomId, type: 'p' });
      return roomId;
    } catch {
      // Not found as private either
    }

    // Last resort: search rooms.get for exact name match
    try {
      const data = await this.apiCallWithReauth<{ update: Array<{ _id: string; name: string; t: string }> }>(() =>
        this.apiGet('/api/v1/rooms.get')
      );
      const room = (data.update || []).find(r => r.name === channelName);
      if (room) {
        const type = room.t === 'p' ? 'p' as const : 'c' as const;
        this.channelCache.set(channelName, { roomId: room._id, type });
        return room._id;
      }
    } catch {
      // rooms.get failed
    }

    throw new Error(`Channel "${channelName}" not found (tried public, private, and rooms.get)`);
  }

  // Get the room type for a cached channel
  private getRoomType(channelName: string): 'c' | 'p' {
    return this.channelCache.get(channelName)?.type || 'c';
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

  async getMessages(roomId: string, count: number = 20, channelName?: string): Promise<FormattedMessage[]> {
    const safeCount = Math.min(Math.max(1, count), 100);
    const roomType = channelName ? this.getRoomType(channelName) : 'c';

    // Use groups.history for private channels, channels.history for public
    const endpoint = roomType === 'p' ? 'groups.history' : 'channels.history';

    try {
      const data = await this.apiCallWithReauth<{ messages: RocketChatMessage[] }>(() =>
        this.apiGet(`/api/v1/${endpoint}?roomId=${roomId}&count=${safeCount}`)
      );
      return (data.messages || []).map(m => this.formatMessage(m));
    } catch {
      // Fallback: try the other endpoint
      const fallback = roomType === 'p' ? 'channels.history' : 'groups.history';
      const data = await this.apiCallWithReauth<{ messages: RocketChatMessage[] }>(() =>
        this.apiGet(`/api/v1/${fallback}?roomId=${roomId}&count=${safeCount}`)
      );
      return (data.messages || []).map(m => this.formatMessage(m));
    }
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
    const allChannels: FormattedChannel[] = [];

    // Get public joined channels
    try {
      const data = await this.apiCallWithReauth<{ channels: RocketChatChannel[] }>(() =>
        this.apiGet('/api/v1/channels.list.joined?count=50')
      );
      for (const ch of data.channels || []) {
        this.channelCache.set(ch.name, { roomId: ch._id, type: 'c' });
        allChannels.push(this.formatChannel(ch));
      }
    } catch { /* no public channels */ }

    // Get private groups
    try {
      const data = await this.apiCallWithReauth<{ groups: RocketChatChannel[] }>(() =>
        this.apiGet('/api/v1/groups.listAll?count=50')
      );
      for (const gr of data.groups || []) {
        this.channelCache.set(gr.name, { roomId: gr._id, type: 'p' });
        allChannels.push(this.formatChannel(gr));
      }
    } catch { /* no private groups or no permission */ }

    return allChannels;
  }

  async getChannelInfo(channelName: string): Promise<FormattedChannel> {
    // Resolve the channel first (handles public + private)
    await this.resolveChannelId(channelName);
    const cached = this.channelCache.get(channelName);

    if (cached?.type === 'p') {
      const data = await this.apiCallWithReauth<{ group: RocketChatChannel }>(() =>
        this.apiGet(`/api/v1/groups.info?roomName=${encodeURIComponent(channelName)}`)
      );
      return this.formatChannel(data.group);
    }

    const data = await this.apiCallWithReauth<{ channel: RocketChatChannel }>(() =>
      this.apiGet(`/api/v1/channels.info?roomName=${encodeURIComponent(channelName)}`)
    );
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
