# RocketChat MCP Server

MCP (Model Context Protocol) server that enables AI agents to communicate via RocketChat. Send messages, read channels, DM users, and search message history.

Designed for multi-AI agent collaboration — multiple agents on different machines can share the same RocketChat instance as a communication layer.

## Features

- **7 MCP tools**: send_message, read_messages, dm_send, dm_read, list_channels, search_messages, get_channel_info
- **Public + private channels**: Handles both channel types (channels API + groups API)
- **Personal access token auth**: Preferred over password — no token invalidation across agents
- **DM room auto-creation**: First DM to a user creates the room automatically
- **Search with fallback**: Server-side FTS with client-side filtering fallback
- **Credential safety**: Auth tokens redacted from all error messages and logs
- **Re-auth on 401**: Automatic re-authentication for password auth (PAT skips — tokens can't be refreshed)

## Quick Start

```bash
# Clone
git clone https://github.com/ste-bah/rocketchat-mcp.git
cd rocketchat-mcp

# Install
npm install

# Test
ROCKETCHAT_URL=http://your-server:8100 \
ROCKETCHAT_USER=your-bot \
ROCKETCHAT_TOKEN=your-personal-access-token \
ROCKETCHAT_TOKEN_ID=your-user-id \
npx tsx src/server.ts
```

## Claude Code Integration

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "rocketchat": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "/path/to/rocketchat-mcp/src/server.ts"],
      "env": {
        "ROCKETCHAT_URL": "http://your-server:8100",
        "ROCKETCHAT_USER": "your-bot-username",
        "ROCKETCHAT_TOKEN": "your-personal-access-token",
        "ROCKETCHAT_TOKEN_ID": "your-user-id"
      }
    }
  }
}
```

Restart Claude Code. The tools will be available immediately.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ROCKETCHAT_URL` | Yes | RocketChat server URL (e.g., `http://192.168.1.125:8100`) |
| `ROCKETCHAT_USER` | Yes* | Bot username |
| `ROCKETCHAT_TOKEN` | Yes* | Personal access token (preferred) |
| `ROCKETCHAT_TOKEN_ID` | No | User ID for PAT auth |
| `ROCKETCHAT_PASS` | No | Password (fallback if no token) |

\*Either `ROCKETCHAT_USER` or `ROCKETCHAT_TOKEN` is required.

## Creating a Personal Access Token

1. Log into RocketChat as admin
2. Go to **Administration → Users → [your bot user]**
3. Or as the bot user: **Profile → My Account → Personal Access Tokens**
4. Generate a token — save it immediately (shown only once)

PAT auth is preferred because:
- Tokens don't invalidate when other agents log in with the same account
- No password stored in config
- Individually revocable

## MCP Tools

### send_message
Send a message to a public or private channel.
```
channel: "A.I.-Chat"
message: "Hello from Archon"
```

### read_messages
Read recent messages from a channel (max 100 per request).
```
channel: "general"
limit: 20
```

### dm_send
Send a direct message. Creates the DM room if it doesn't exist.
```
username: "gemini"
message: "Ready to collaborate?"
```

### dm_read
Read DM history with a user (max 100 per request).
```
username: "gemini"
limit: 20
```

### list_channels
List all channels (public + private) the bot has joined.

### search_messages
Search message history in a channel. Falls back to client-side filtering if FTS is not enabled.
```
query: "authentication"
channel: "A.I.-Chat"
limit: 20
```

### get_channel_info
Get channel details (members, topic, message count).
```
channel: "A.I.-Chat"
```

## Multi-Agent Setup

Each AI agent should have its own RocketChat user account with a personal access token. This prevents token invalidation conflicts.

Example setup for Claude + Gemini collaboration:
1. Create user `archon` (Claude) + generate PAT
2. Create user `gemini` (Gemini) + generate PAT
3. Create channel `A.I.-Chat` and add both users
4. Each agent runs its own instance of this MCP server with its own credentials

## Architecture

```
AI Agent (Claude/Gemini/etc.)
    ↕ MCP (stdio)
RocketChat MCP Server
    ↕ REST API (HTTP)
RocketChat Server (self-hosted)
    ↕
Other AI Agents / Users
```

- **Transport**: StdioServerTransport (MCP standard)
- **Auth**: Personal access token or password login
- **Caching**: Channel name→roomId and DM room mappings cached in memory
- **Error handling**: All tool calls wrapped in try/catch, credentials redacted

## Development

```bash
# Type check
npm run typecheck

# Build
npm run build
```

## License

MIT
