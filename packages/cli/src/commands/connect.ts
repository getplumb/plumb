import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ConnectOptions {
  /** The tool to connect: 'claude-desktop', 'claude-code', 'cursor', 'openclaw' */
  tool?: string;
}

type SupportedTool = 'claude-desktop' | 'claude-code' | 'cursor' | 'openclaw';

const SUPPORTED_TOOLS: SupportedTool[] = ['claude-desktop', 'claude-code', 'cursor', 'openclaw'];

/**
 * Get the config file path for a given tool on the current platform.
 */
function getConfigPath(tool: SupportedTool): string {
  const platform = process.platform;
  const home = homedir();

  switch (tool) {
    case 'claude-desktop':
      if (platform === 'darwin') {
        return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      } else if (platform === 'win32') {
        return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
      } else {
        return join(home, '.config', 'Claude', 'claude_desktop_config.json');
      }

    case 'claude-code':
      if (platform === 'darwin') {
        return join(home, 'Library', 'Application Support', 'Claude Code', 'User', 'mcp.json');
      } else if (platform === 'win32') {
        return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude Code', 'User', 'mcp.json');
      } else {
        return join(home, '.config', 'Claude Code', 'User', 'mcp.json');
      }

    case 'cursor':
      if (platform === 'darwin') {
        return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json');
      } else if (platform === 'win32') {
        return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'settings.json');
      } else {
        return join(home, '.config', 'Cursor', 'User', 'settings.json');
      }

    case 'openclaw':
      // OpenClaw uses a different setup pattern (see below)
      return '(see instructions below)';
  }
}

/**
 * Get the MCP config snippet for a given tool.
 */
function getConfigSnippet(tool: SupportedTool): string {
  switch (tool) {
    case 'claude-desktop':
      return `{
  "mcpServers": {
    "plumb": {
      "command": "plumb-mcp",
      "args": []
    }
  }
}`;

    case 'claude-code':
      return `{
  "mcpServers": {
    "plumb": {
      "command": "plumb-mcp",
      "args": []
    }
  }
}`;

    case 'cursor':
      return `{
  "mcp.servers": {
    "plumb": {
      "command": "plumb-mcp",
      "args": []
    }
  }
}`;

    case 'openclaw':
      // For OpenClaw, we provide manual wiring instructions instead of a config snippet.
      return '';
  }
}

/**
 * Print connection instructions for OpenClaw.
 */
function printOpenClawInstructions(): void {
  console.log('OpenClaw Plugin Setup');
  console.log('─────────────────────');
  console.log();
  console.log('OpenClaw uses a plugin-based approach instead of MCP config.');
  console.log('To connect Plumb to OpenClaw:');
  console.log();
  console.log('1. Install the Plumb OpenClaw plugin:');
  console.log('   npm install -g @plumb/openclaw-plugin');
  console.log();
  console.log('2. Wire the plugin in your OpenClaw config:');
  console.log('   Add to ~/.openclaw/config.json or your project config:');
  console.log();
  console.log('   {');
  console.log('     "plugins": [');
  console.log('       "@plumb/openclaw-plugin"');
  console.log('     ]');
  console.log('   }');
  console.log();
  console.log('3. Restart OpenClaw to load the plugin.');
  console.log();
  console.log('For more details, see: https://docs.getplumb.dev/integrations/openclaw');
}

/**
 * Connect command handler.
 * Prints MCP config snippets and instructions for connecting to various tools.
 */
export function connectCommand(options: ConnectOptions): void {
  const tool = options.tool?.toLowerCase();

  // If no tool specified, print usage help.
  if (!tool) {
    console.log('Usage: plumb connect <tool>');
    console.log();
    console.log('Supported tools:');
    console.log('  claude-desktop   Claude Desktop app (macOS/Windows/Linux)');
    console.log('  claude-code      Claude Code (macOS/Windows/Linux)');
    console.log('  cursor           Cursor editor (macOS/Windows/Linux)');
    console.log('  openclaw         OpenClaw CLI (plugin-based setup)');
    console.log();
    console.log('Example:');
    console.log('  plumb connect claude-desktop');
    return;
  }

  // Validate tool name.
  if (!SUPPORTED_TOOLS.includes(tool as SupportedTool)) {
    console.error(`Error: Unknown tool "${tool}"`);
    console.error(`Supported tools: ${SUPPORTED_TOOLS.join(', ')}`);
    process.exit(1);
  }

  const supportedTool = tool as SupportedTool;

  // Special case: OpenClaw has a different setup pattern.
  if (supportedTool === 'openclaw') {
    printOpenClawInstructions();
    return;
  }

  // Standard MCP config snippet pattern.
  const configPath = getConfigPath(supportedTool);
  const snippet = getConfigSnippet(supportedTool);

  console.log(`Connecting Plumb to ${supportedTool}`);
  console.log('─'.repeat(30 + supportedTool.length));
  console.log();
  console.log(`Config file: ${configPath}`);
  console.log();
  console.log('Add this to your config file:');
  console.log();
  console.log(snippet);
  console.log();
  console.log('Then restart the application to load the MCP server.');
  console.log();
  console.log('Note: Make sure you have installed the MCP server first:');
  console.log('  npm install -g @plumb/mcp-server');
}
