# @plumb/mcp-server

Local MCP server that provides memory tools to Claude Desktop and other MCP clients.

## Installation

```bash
npm install -g @plumb/mcp-server
```

## Quick Start

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "plumb": {
      "command": "plumb-mcp"
    }
  }
}
```

Restart Claude Desktop. You'll now have access to memory tools:
- `plumb_add_memory` — store thoughts, facts, and context
- `plumb_search_memory` — retrieve relevant memories
- `plumb_list_memory` — browse all memories

## Documentation

Full docs at [docs.getplumb.dev](https://docs.getplumb.dev)

## License

MIT
