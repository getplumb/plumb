import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { updateClaudeMd } from './write-claude-md.js';

export interface ConnectOptions {
  /** The tool to connect: 'claude-desktop', 'claude-code', 'cursor', 'openclaw' */
  tool?: string;
}

export type SupportedTool = 'claude-desktop' | 'claude-code' | 'cursor' | 'openclaw';

const SUPPORTED_TOOLS: SupportedTool[] = ['claude-desktop', 'claude-code', 'cursor', 'openclaw'];

/**
 * Get the config file path for a given tool on the current platform.
 */
export function getConfigPath(tool: SupportedTool): string {
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
      // Claude Code reads from ~/.claude.json (or ~/.claude/settings.json)
      return join(home, '.claude.json');

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
export function getMcpSnippet(tool: SupportedTool): string {
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
  console.log('   npm install -g @getplumb/openclaw-plugin');
  console.log();
  console.log('2. Configure the plugin in openclaw.json:');
  console.log('   Add to ~/.openclaw/openclaw.json (or your project config):');
  console.log();
  console.log('   {');
  console.log('     "plugins": {');
  console.log('       "plumb": {');
  console.log('         "enabled": true,');
  console.log('         "config": {');
  console.log('           "dbPath": "/home/user/.plumb/memory.db",');
  console.log('           "userId": "your-username",');
  console.log('           "shadowMode": false,');
  console.log('           "llmProvider": "anthropic",');
  console.log('           "llmModel": "claude-haiku-4-5-20251001",');
  console.log('           "llmApiKey": "sk-ant-..."');
  console.log('         }');
  console.log('       }');
  console.log('     }');
  console.log('   }');
  console.log();
  console.log('3. Restart OpenClaw to load the plugin.');
  console.log();
  console.log('IMPORTANT: Service-based runtime considerations');
  console.log('─────────────────────────────────────────────────');
  console.log();
  console.log('OpenClaw runs as a systemd service and does NOT source shell RC files');
  console.log('like ~/.zshrc or ~/.bashrc. This means environment variables set by');
  console.log('`plumb setup` will not be visible to the OpenClaw gateway process.');
  console.log();
  console.log('Recommended approach: Configure LLM provider in openclaw.json (shown above).');
  console.log();
  console.log('Alternative: Set env vars for the OpenClaw service directly:');
  console.log('   openclaw gateway env set PLUMB_LLM_PROVIDER=anthropic');
  console.log('   openclaw gateway env set ANTHROPIC_API_KEY=sk-ant-...');
  console.log('   openclaw gateway restart');
  console.log();
  console.log('For more details, see: https://docs.getplumb.dev/integrations/openclaw');
}

/**
 * Print connection instructions for Claude Code and write CLAUDE.md.
 */
function printClaudeCodeInstructions(): void {
  console.log('Connecting Plumb to claude-code');
  console.log('────────────────────────────────');
  console.log();
  console.log('Run this command to register Plumb (recommended):');
  console.log('  claude mcp add plumb --scope user -- plumb-mcp');
  console.log();
  console.log('Or add manually to ~/.claude.json:');
  console.log('  {');
  console.log('    "mcpServers": {');
  console.log('      "plumb": {');
  console.log('        "command": "plumb-mcp",');
  console.log('        "args": []');
  console.log('      }');
  console.log('    }');
  console.log('  }');
  console.log();
  console.log('Note: Make sure plumb-mcp is installed first:');
  console.log('  npm install -g @getplumb/mcp-server');
  console.log();

  // Write CLAUDE.md with prescriptive instructions
  const home = homedir();
  const claudeDir = join(home, '.claude');
  const claudeMdPath = join(claudeDir, 'CLAUDE.md');

  try {
    // Ensure .claude directory exists
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    // Read existing content if file exists
    const existingContent = existsSync(claudeMdPath)
      ? readFileSync(claudeMdPath, 'utf-8')
      : undefined;

    // Update with Plumb section
    const updatedContent = updateClaudeMd(existingContent);

    // Write updated content
    writeFileSync(claudeMdPath, updatedContent, 'utf-8');

    console.log('✓ Updated ~/.claude/CLAUDE.md with Plumb memory integration instructions');
    console.log();
  } catch (err) {
    console.error('Warning: Failed to write ~/.claude/CLAUDE.md:', err instanceof Error ? err.message : String(err));
    console.log();
  }

  console.log('Troubleshooting:');
  console.log('  If the server doesn\'t appear, launch Claude Code from your home directory');
  console.log('  or a project root — user-scoped MCP servers may not load from other directories.');
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

  // Special case: Claude Code uses CLI-based registration.
  if (supportedTool === 'claude-code') {
    printClaudeCodeInstructions();
    return;
  }

  // Standard MCP config snippet pattern.
  const configPath = getConfigPath(supportedTool);
  const snippet = getMcpSnippet(supportedTool);

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
