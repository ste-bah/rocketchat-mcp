/**
 * RocketChat MCP Server
 *
 * Enables AI agents to communicate via RocketChat — send/receive messages,
 * read channels, DM other agents/users, and search message history.
 *
 * Auth: Supports personal access tokens (preferred) or password login.
 * Config via environment variables:
 *   ROCKETCHAT_URL      — e.g., http://192.168.59.1:8100
 *   ROCKETCHAT_USER     — username
 *   ROCKETCHAT_PASS     — password (for password auth)
 *   ROCKETCHAT_TOKEN    — personal access token (preferred)
 *   ROCKETCHAT_TOKEN_ID — personal access token user ID
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { RocketChatClient } from './client.js';
import type {
  SendMessageInput,
  ReadMessagesInput,
  DMSendInput,
  DMReadInput,
  SearchMessagesInput,
  GetChannelInfoInput,
} from './types.js';

// ── Config ──

const config = {
  url: process.env.ROCKETCHAT_URL || 'http://localhost:3000',
  user: process.env.ROCKETCHAT_USER || '',
  password: process.env.ROCKETCHAT_PASS || undefined,
  personalAccessToken: process.env.ROCKETCHAT_TOKEN || undefined,
  personalAccessTokenId: process.env.ROCKETCHAT_TOKEN_ID || undefined,
};

if (!config.user && !config.personalAccessToken) {
  console.error('[rocketchat-mcp] ROCKETCHAT_USER or ROCKETCHAT_TOKEN required');
  process.exit(1);
}

// ── Client ──

const client = new RocketChatClient(config);

// ── Tool Definitions ──

const TOOLS = [
  {
    name: 'send_message',
    description: 'Send a message to a RocketChat channel by name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', description: 'Channel name (e.g., "general")' },
        message: { type: 'string', description: 'Message text to send' },
      },
      required: ['channel', 'message'],
    },
  },
  {
    name: 'read_messages',
    description: 'Read recent messages from a RocketChat channel. Returns up to 100 messages (RocketChat API limit).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', description: 'Channel name' },
        limit: { type: 'number', description: 'Max messages to return (default 20, max 100)' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'dm_send',
    description: 'Send a direct message to a RocketChat user. Creates the DM room if it does not exist.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        username: { type: 'string', description: 'Target username' },
        message: { type: 'string', description: 'Message text to send' },
      },
      required: ['username', 'message'],
    },
  },
  {
    name: 'dm_read',
    description: 'Read direct message history with a RocketChat user. Returns up to 100 messages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        username: { type: 'string', description: 'Username of the DM partner' },
        limit: { type: 'number', description: 'Max messages to return (default 20, max 100)' },
      },
      required: ['username'],
    },
  },
  {
    name: 'list_channels',
    description: 'List all RocketChat channels the bot has joined.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'search_messages',
    description: 'Search message history in a channel. Falls back to client-side filtering if full-text search is not enabled on the server.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search text' },
        channel: { type: 'string', description: 'Channel name to search in (required)' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
      required: ['query', 'channel'],
    },
  },
  {
    name: 'get_channel_info',
    description: 'Get details about a RocketChat channel (members, topic, message count).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', description: 'Channel name' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'upload_file',
    description: 'Upload a local file to a RocketChat channel or DM. Max 25MB by default (configurable via ROCKETCHAT_MAX_UPLOAD_MB env var).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', description: 'Channel name to upload to (use this OR username, not both)' },
        username: { type: 'string', description: 'Username to DM the file to (use this OR channel, not both)' },
        file_path: { type: 'string', description: 'Absolute or relative path to the local file' },
        description: { type: 'string', description: 'Optional message text to accompany the file' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'download_file',
    description: 'Download a file attachment from RocketChat to a local path. Only allows downloads from the configured RocketChat server (SSRF protection).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_url: { type: 'string', description: 'File URL from a RocketChat message attachment (absolute or relative)' },
        save_path: { type: 'string', description: 'Local path to save the file to (must be under cwd, home, or /tmp)' },
      },
      required: ['file_url', 'save_path'],
    },
  },
  {
    name: 'view_attachment',
    description: 'Download and view a file attachment from a RocketChat message. Returns the file content for text/images, or metadata for other file types.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Attachment URL (from read_messages response)' },
        save_path: { type: 'string', description: 'Optional: absolute path to save the file locally' },
      },
      required: ['url'],
    },
  },
];

// ── Tool Handlers ──

async function handleSendMessage(input: SendMessageInput): Promise<string> {
  const roomId = await client.resolveChannelId(input.channel);
  const msg = await client.sendMessage(roomId, input.message);
  return JSON.stringify({
    success: true,
    messageId: msg.id,
    channel: input.channel,
    timestamp: msg.timestamp,
  });
}

async function handleReadMessages(input: ReadMessagesInput): Promise<string> {
  const roomId = await client.resolveChannelId(input.channel);
  const messages = await client.getMessages(roomId, input.limit || 20, input.channel);
  return JSON.stringify({
    channel: input.channel,
    count: messages.length,
    messages: messages.map(m => ({
      username: m.username,
      text: m.text,
      timestamp: m.timestamp,
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      ...(m.file ? { file: m.file } : {}),
    })),
  });
}

async function handleDMSend(input: DMSendInput): Promise<string> {
  const roomId = await client.resolveDMRoomId(input.username);
  const msg = await client.sendMessage(roomId, input.message);
  return JSON.stringify({
    success: true,
    messageId: msg.id,
    to: input.username,
    timestamp: msg.timestamp,
  });
}

async function handleDMRead(input: DMReadInput): Promise<string> {
  const roomId = await client.resolveDMRoomId(input.username);
  const messages = await client.getDMMessages(roomId, input.limit || 20);
  return JSON.stringify({
    username: input.username,
    count: messages.length,
    messages: messages.map(m => ({
      username: m.username,
      text: m.text,
      timestamp: m.timestamp,
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      ...(m.file ? { file: m.file } : {}),
    })),
  });
}

async function handleListChannels(): Promise<string> {
  const channels = await client.listChannels();
  return JSON.stringify({
    count: channels.length,
    channels: channels.map(ch => ({
      name: ch.name,
      type: ch.type,
      messages: ch.messageCount,
      members: ch.memberCount,
      topic: ch.topic || undefined,
    })),
  });
}

async function handleSearchMessages(input: SearchMessagesInput): Promise<string> {
  const roomId = await client.resolveChannelId(input.channel!);
  const messages = await client.searchMessages(roomId, input.query, input.limit || 20);
  return JSON.stringify({
    channel: input.channel,
    query: input.query,
    count: messages.length,
    messages: messages.map(m => ({
      username: m.username,
      text: m.text,
      timestamp: m.timestamp,
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      ...(m.file ? { file: m.file } : {}),
    })),
  });
}

async function handleGetChannelInfo(input: GetChannelInfoInput): Promise<string> {
  const info = await client.getChannelInfo(input.channel);
  return JSON.stringify(info);
}

async function handleUploadFile(input: { channel?: string; username?: string; file_path: string; description?: string }): Promise<string> {
  if (!input.channel && !input.username) {
    throw new Error('Either channel or username is required');
  }

  let roomId: string;
  if (input.username) {
    roomId = await client.resolveDMRoomId(input.username);
  } else {
    roomId = await client.resolveChannelId(input.channel!);
  }

  const result = await client.uploadFile(roomId, input.file_path, input.description);
  return JSON.stringify({
    success: true,
    target: input.channel || input.username,
    fileUrl: result.fileUrl,
    messageId: result.messageId,
  });
}

async function handleDownloadFile(input: { file_url: string; save_path: string }): Promise<string> {
  const result = await client.downloadFile(input.file_url, input.save_path);
  return JSON.stringify(result);
}

async function handleViewAttachment(input: { url: string; save_path?: string }): Promise<string> {
  if (!input.url) throw new Error('"url" is required');

  // Use the existing download_file method from the client (SSRF-protected)
  if (input.save_path) {
    const downloadResult = await client.downloadFile(input.url, input.save_path);
    return JSON.stringify(downloadResult);
  }

  // If no save_path, just return metadata about the attachment
  return JSON.stringify({
    url: input.url,
    note: 'Provide a save_path to download the file, or use the download_file tool directly.',
  });
}

// ── MCP Server ──

const server = new Server(
  { name: 'rocketchat-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case 'send_message':
        result = await handleSendMessage(args as unknown as SendMessageInput);
        break;
      case 'read_messages':
        result = await handleReadMessages(args as unknown as ReadMessagesInput);
        break;
      case 'dm_send':
        result = await handleDMSend(args as unknown as DMSendInput);
        break;
      case 'dm_read':
        result = await handleDMRead(args as unknown as DMReadInput);
        break;
      case 'list_channels':
        result = await handleListChannels();
        break;
      case 'search_messages':
        result = await handleSearchMessages(args as unknown as SearchMessagesInput);
        break;
      case 'get_channel_info':
        result = await handleGetChannelInfo(args as unknown as GetChannelInfoInput);
        break;
      case 'upload_file':
        result = await handleUploadFile(args as unknown as { channel?: string; username?: string; file_path: string; description?: string });
        break;
      case 'download_file':
        result = await handleDownloadFile(args as unknown as { file_url: string; save_path: string });
        break;
      case 'view_attachment':
        result = await handleViewAttachment(args as unknown as { url: string; save_path?: string });
        break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return { content: [{ type: 'text', text: result }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Don't log credentials or auth tokens in error messages
    const safeMessage = message
      .replace(/X-Auth-Token:\s*\S+/gi, 'X-Auth-Token: [REDACTED]')
      .replace(/X-User-Id:\s*\S+/gi, 'X-User-Id: [REDACTED]')
      .replace(/authToken[=:"]\s*\S+/gi, 'authToken=[REDACTED]')
      .replace(/password[=:"]\s*\S+/gi, 'password=[REDACTED]');
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: safeMessage }) }],
      isError: true,
    };
  }
});

// ── Startup ──

async function main() {
  console.error('[rocketchat-mcp] Starting RocketChat MCP server...');
  console.error(`[rocketchat-mcp] URL: ${config.url}`);
  console.error(`[rocketchat-mcp] User: ${config.user}`);
  console.error(`[rocketchat-mcp] Auth: ${config.personalAccessToken ? 'personal access token' : 'password'}`);

  // Authenticate BEFORE starting the transport
  try {
    await client.login();
  } catch (error) {
    // Never log the raw error — it may contain credentials or auth tokens
    const msg = error instanceof Error ? error.message : 'Unknown error';
    const safeMsg = msg.replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]')
      .replace(/authToken[=:"]\s*\S+/gi, 'authToken=[REDACTED]');
    console.error(`[rocketchat-mcp] Authentication failed: ${safeMsg}`);
    process.exit(1);
  }

  // Start MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[rocketchat-mcp] MCP server connected and ready');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.error('[rocketchat-mcp] Shutting down...');
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('[rocketchat-mcp] Shutting down...');
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(`[rocketchat-mcp] Fatal error: ${error}`);
  process.exit(1);
});
