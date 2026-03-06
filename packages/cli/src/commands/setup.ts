import { select, input, confirm, password } from '@inquirer/prompts';
import { exec, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import OpenAI from 'openai';
import ora from 'ora';
import { LocalStore } from '@getplumb/core';
import { extractFacts } from '@getplumb/core';
import { getConfigPath, getMcpSnippet, type SupportedTool } from './connect.js';
import { getDefaultDbPath } from '../utils/db-path.js';

const execAsync = promisify(exec);

type Provider = 'openai' | 'anthropic' | 'ollama' | 'openai-compatible';

interface SetupResult {
  provider: Provider;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Check if a key is already set in the environment
 */
function checkExistingKey(provider: Provider): string | undefined {
  if (provider === 'openai' || provider === 'openai-compatible') {
    return process.env['OPENAI_API_KEY'];
  }
  if (provider === 'anthropic') {
    return process.env['ANTHROPIC_API_KEY'];
  }
  return undefined;
}

/**
 * Validate the API key by making a test LLM call
 */
async function validateKey(result: SetupResult): Promise<boolean> {
  try {
    if (result.provider === 'openai') {
      const client = new OpenAI({ apiKey: result.apiKey });
      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say OK' }],
        max_tokens: 5,
      });
      return response.choices[0]?.message?.content !== undefined;
    }

    if (result.provider === 'anthropic') {
      // Dynamic import for optional dependency
      let Anthropic: typeof import('@anthropic-ai/sdk').default;
      try {
        Anthropic = (await import('@anthropic-ai/sdk')).default;
      } catch {
        console.error('\nError: Anthropic provider requires @anthropic-ai/sdk');
        console.error('Install it with: npm install -g @anthropic-ai/sdk');
        return false;
      }

      const client = new Anthropic({ apiKey: result.apiKey });
      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Say OK' }],
      });
      return message.content[0]?.type === 'text';
    }

    if (result.provider === 'ollama') {
      // Ping Ollama to confirm it's running
      const baseURL = process.env['OLLAMA_HOST'] ?? 'http://localhost:11434/v1';
      const client = new OpenAI({
        baseURL,
        apiKey: 'ollama',
      });
      const response = await client.chat.completions.create({
        model: 'llama3.1',
        messages: [{ role: 'user', content: 'Say OK' }],
        max_tokens: 5,
      });
      return response.choices[0]?.message?.content !== undefined;
    }

    if (result.provider === 'openai-compatible') {
      const client = new OpenAI({
        baseURL: result.baseUrl,
        apiKey: result.apiKey,
      });
      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say OK' }],
        max_tokens: 5,
      });
      return response.choices[0]?.message?.content !== undefined;
    }

    return false;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nValidation failed: ${message}`);
    return false;
  }
}

/**
 * Persist environment variable on Windows using PowerShell
 */
async function persistWindowsEnv(name: string, value: string): Promise<void> {
  const command = `powershell -Command "[Environment]::SetEnvironmentVariable('${name}', '${value}', 'User')"`;
  await execAsync(command);
}

/**
 * Persist environment variable on macOS/Linux by appending to shell RC files
 */
function persistUnixEnv(name: string, value: string): void {
  const home = homedir();
  const rcFiles = ['.zshrc', '.bashrc'];
  const exportLine = `\nexport ${name}=${value}\n`;

  for (const rcFile of rcFiles) {
    const rcPath = join(home, rcFile);
    if (existsSync(rcPath)) {
      // Check if the export already exists
      const content = readFileSync(rcPath, 'utf-8');
      if (!content.includes(`export ${name}=`)) {
        appendFileSync(rcPath, exportLine, 'utf-8');
        console.log(`  ✓ Added to ~/${rcFile}`);
      } else {
        console.log(`  ℹ Already exists in ~/${rcFile}`);
      }
    }
  }
}

/**
 * Persist environment variables to the OS
 */
async function persistEnv(result: SetupResult): Promise<void> {
  const isWindows = platform() === 'win32';

  console.log('\nPersisting environment variables...');

  // Set PLUMB_LLM_PROVIDER if not OpenAI
  if (result.provider !== 'openai') {
    if (isWindows) {
      await persistWindowsEnv('PLUMB_LLM_PROVIDER', result.provider);
    } else {
      persistUnixEnv('PLUMB_LLM_PROVIDER', result.provider);
    }
    console.log(`  ✓ PLUMB_LLM_PROVIDER=${result.provider}`);
  }

  // Set API key
  if (result.apiKey) {
    const keyName =
      result.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    if (isWindows) {
      await persistWindowsEnv(keyName, result.apiKey);
    } else {
      persistUnixEnv(keyName, result.apiKey);
    }
    console.log(`  ✓ ${keyName} set`);
  }

  // Set base URL for openai-compatible
  if (result.provider === 'openai-compatible' && result.baseUrl) {
    if (isWindows) {
      await persistWindowsEnv('PLUMB_LLM_BASE_URL', result.baseUrl);
    } else {
      persistUnixEnv('PLUMB_LLM_BASE_URL', result.baseUrl);
    }
    console.log(`  ✓ PLUMB_LLM_BASE_URL=${result.baseUrl}`);
  }

  if (isWindows) {
    console.log('\n⚠️  Important: Open a NEW terminal for changes to take effect.');
  } else {
    console.log('\n⚠️  Important: Run `source ~/.zshrc` or open a new terminal.');
  }

  // Bootstrap: create the DB immediately with a seed fact so `plumb status` works right away
  const dbSpinner = ora('Initializing memory database...').start();
  try {
    const dbPath = getDefaultDbPath();
    const store = await LocalStore.create({ dbPath, userId: 'default' });
    const seedExchange = {
      userMessage: `I just set up Plumb on ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`,
      agentResponse: `Setup complete. You configured Plumb with the ${result.provider} provider. Your memory database is now active and will start capturing facts from your AI conversations.`,
      timestamp: new Date(),
      source: 'openclaw' as const,
      sessionId: 'setup',
      sessionLabel: 'plumb-setup',
    };
    await extractFacts(seedExchange, 'default', store);
    dbSpinner.succeed('Memory database ready');
  } catch (err: unknown) {
    // Non-fatal: DB will be created on first ingest
    dbSpinner.warn('Could not initialize database — run plumb ingest to create it.');
  }
}

/**
 * Seed user context with optional personalization questions
 */
async function seedUserContext(): Promise<void> {
  console.log('\nA few quick questions to personalize your memory (all optional):');
  console.log();

  const name = await input({
    message: "What's your name? (optional, press Enter to skip)",
    default: '',
  });

  const timezone = await input({
    message: "What's your timezone? (optional, e.g. America/Denver)",
    default: '',
  });

  const useCase = await input({
    message: 'What are you mainly using Plumb for? (optional, e.g. job search, coding, research)',
    default: '',
  });

  // Build seed exchange only if at least one answer provided
  const answers = [];
  if (name && name.trim() !== '') {
    answers.push(`My name is ${name.trim()}.`);
  }
  if (timezone && timezone.trim() !== '') {
    answers.push(`I am in the ${timezone.trim()} timezone.`);
  }
  if (useCase && useCase.trim() !== '') {
    answers.push(`I mainly use Plumb for ${useCase.trim()}.`);
  }

  // If user skipped all questions, skip the seed
  if (answers.length === 0) {
    return;
  }

  // Extract facts
  try {
    const dbPath = getDefaultDbPath();
    const store = await LocalStore.create({ dbPath, userId: 'default' });
    const seedExchange = {
      userMessage: answers.join(' '),
      agentResponse: "Got it. I'll remember that for future conversations.",
      timestamp: new Date(),
      source: 'openclaw' as const,
      sessionId: 'setup',
      sessionLabel: 'plumb-setup',
    };
    await extractFacts(seedExchange, 'default', store);
  } catch (err: unknown) {
    // Non-fatal: facts will be extracted on first real conversation
    console.log('\n⚠️  Could not store personalization facts — they will be captured on first use.');
  }
}

/**
 * Check if the MCP server (plumb-mcp) is installed in PATH.
 * Returns true if found, false otherwise.
 */
function checkMcpServerInstalled(): boolean {
  try {
    const isWindows = platform() === 'win32';
    const cmd = isWindows ? 'where' : 'which';
    execFileSync(cmd, ['plumb-mcp'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if OpenClaw is installed in PATH.
 * Returns true if found, false otherwise.
 */
function checkOpenClawInstalled(): boolean {
  try {
    const isWindows = platform() === 'win32';
    const cmd = isWindows ? 'where.exe' : 'which';
    execFileSync(cmd, ['openclaw'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Prompt user to install MCP server and execute installation if confirmed.
 */
async function installMcpServer(): Promise<void> {
  console.log('\nChecking MCP server installation...');

  if (checkMcpServerInstalled()) {
    console.log('✓ MCP server already installed\n');
    return;
  }

  console.log('MCP server not found.');
  const shouldInstall = await confirm({
    message: 'Install MCP server now? (npm install -g @getplumb/mcp-server)',
    default: true,
  });

  if (!shouldInstall) {
    console.log('\nRun: npm install -g @getplumb/mcp-server when ready\n');
    return;
  }

  console.log('\nInstalling MCP server...\n');

  try {
    await execAsync('npm install -g @getplumb/mcp-server');
    if (checkMcpServerInstalled()) {
      console.log('\n✓ MCP server installed\n');
    } else {
      console.warn('\n⚠️  Installation completed but plumb-mcp not found in PATH.');
      console.warn('Try running: npm install -g @getplumb/mcp-server manually\n');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n⚠️  Installation failed: ${message}`);
    console.error('Run manually: npm install -g @getplumb/mcp-server\n');
  }
}

/**
 * Get the path to openclaw.json based on the current platform.
 */
function getOpenClawConfigPath(): string | null {
  const isWindows = platform() === 'win32';

  if (isWindows) {
    const appData = process.env['APPDATA'];
    if (!appData) return null;
    return join(appData, 'openclaw', 'openclaw.json');
  } else {
    return join(homedir(), '.openclaw', 'openclaw.json');
  }
}

/**
 * Print manual instructions for configuring Plumb in openclaw.json.
 */
function printOpenClawManualInstructions(userId: string): void {
  console.log('\nTo configure Plumb manually, add this to your openclaw.json:');
  console.log('\n{');
  console.log('  "plugins": {');
  console.log('    "allow": ["plumb"],');
  console.log('    "slots": { "memory": "plumb" },');
  console.log('    "entries": {');
  console.log('      "plumb": {');
  console.log('        "enabled": true,');
  console.log('        "config": {');
  console.log(`          "dbPath": "~/.plumb/memory.db",`);
  console.log(`          "userId": "${userId}",`);
  console.log('          "shadowMode": false');
  console.log('        }');
  console.log('      }');
  console.log('    }');
  console.log('  }');
  console.log('}\n');
  console.log('Then restart OpenClaw to activate.\n');
}

/**
 * Interactive tool connection flow with upsell for second connections.
 */
async function interactiveToolConnection(): Promise<void> {
  const openClawDetected = checkOpenClawInstalled();

  // First tool selection
  type ToolChoice = SupportedTool | 'skip';
  const toolChoices: Array<{ name: string; value: ToolChoice }> = [
    {
      name: openClawDetected
        ? 'OpenClaw'
        : 'OpenClaw (not detected — install at https://openclaw.ai)',
      value: 'openclaw',
    },
    { name: 'Claude Desktop', value: 'claude-desktop' },
    { name: 'Claude Code', value: 'claude-code' },
    { name: 'Cursor', value: 'cursor' },
    { name: 'Skip for now', value: 'skip' },
  ];

  const firstTool = await select<ToolChoice>({
    message: 'Which tool do you want to connect Plumb to?',
    choices: toolChoices,
  });

  let firstToolConfigured = false;

  // Handle first tool selection
  if (firstTool === 'openclaw') {
    if (openClawDetected) {
      // Run the full OpenClaw wiring flow from T-057
      await setupOpenClaw();
      firstToolConfigured = true;
    } else {
      console.log('\nOpenClaw not detected.');
      console.log('Install at: https://openclaw.ai');
      console.log('Then run `plumb setup` again to wire the connection.\n');
    }
  } else if (firstTool === 'skip') {
    // Skip for now - no output
  } else if (firstTool === 'claude-code') {
    // Claude Code uses CLI-based registration
    console.log('\nRun this command to register Plumb (recommended):');
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
    console.log('Troubleshooting:');
    console.log('  If the server doesn\'t appear, launch Claude Code from your home directory');
    console.log('  or a project root — user-scoped MCP servers may not load from other directories.\n');
    firstToolConfigured = true;
  } else {
    // Claude Desktop / Cursor
    const configPath = getConfigPath(firstTool);
    const snippet = getMcpSnippet(firstTool);

    console.log(`\nConfig file: ${configPath}`);
    console.log('\nAdd this to your config file:\n');
    console.log(snippet);
    console.log('\nThen restart the application to load the MCP server.\n');
    firstToolConfigured = true;
  }

}

/**
 * Configure Plumb plugin in OpenClaw's openclaw.json.
 * This function assumes OpenClaw is already detected in PATH.
 */
async function setupOpenClaw(): Promise<void> {
  // Prompt to configure
  console.log('\nOpenClaw detected!');
  const shouldConfigure = await confirm({
    message: 'Configure Plumb for OpenClaw now?',
    default: true,
  });

  if (!shouldConfigure) {
    // User declined
    const userId = await input({
      message: 'Enter your userId (for manual config):',
      default: 'default',
    });
    printOpenClawManualInstructions(userId);
    return;
  }

  // Prompt for userId
  const userId = await input({
    message: 'Enter your userId:',
    default: 'default',
  });

  // Find openclaw.json
  const configPath = getOpenClawConfigPath();
  if (!configPath || !existsSync(configPath)) {
    console.log('\n⚠️  openclaw.json not found at expected location.');
    printOpenClawManualInstructions(userId);
    return;
  }

  try {
    // Read and parse existing config
    const configContent = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configContent);

    // Ensure plugins structure exists
    if (!config.plugins) {
      config.plugins = {};
    }
    if (!config.plugins.allow) {
      config.plugins.allow = [];
    }
    if (!config.plugins.slots) {
      config.plugins.slots = {};
    }
    if (!config.plugins.entries) {
      config.plugins.entries = {};
    }

    // Check if plumb entry already exists
    if (config.plugins.entries.plumb) {
      const shouldOverwrite = await confirm({
        message: 'Plumb is already configured. Overwrite?',
        default: false,
      });

      if (!shouldOverwrite) {
        console.log('\nSkipping OpenClaw configuration.');
        return;
      }
    }

    // Merge plugin config
    // Add 'plumb' to allow array if not already present
    if (!config.plugins.allow.includes('plumb')) {
      config.plugins.allow.push('plumb');
    }

    // Set memory slot
    config.plugins.slots.memory = 'plumb';

    // Set plumb entry
    config.plugins.entries.plumb = {
      enabled: true,
      config: {
        dbPath: '~/.plumb/memory.db',
        userId,
        shadowMode: false,
      },
    };

    // Write back
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log('\n✓ plumb entry added to openclaw.json. Restart OpenClaw to activate.\n');
  } catch (err: unknown) {
    // On error, fall through to manual instructions
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n⚠️  Error updating openclaw.json: ${message}`);
    printOpenClawManualInstructions(userId);
  }
}

/**
 * Main setup command
 */
export async function setupCommand(): Promise<void> {
  console.log();
  console.log('  🪣  Plumb');
  console.log('  Your AI assistant\'s long-term memory.');
  console.log();

  // Check for existing configuration
  const existingProvider = process.env['PLUMB_LLM_PROVIDER'] ?? 'openai';
  const existingKey = checkExistingKey(existingProvider as Provider);

  let skipProviderSetup = false;

  if (existingKey) {
    console.log(`Current provider: ${existingProvider}`);
    console.log('API key is already configured.\n');

    const reconfigure = await confirm({
      message: 'Do you want to reconfigure?',
      default: false,
    });

    if (!reconfigure) {
      console.log('\n✓ Keeping existing configuration. Continuing setup...\n');
      skipProviderSetup = true;
    } else {
      console.log();
    }
  }

  let result: SetupResult = { provider: existingProvider as Provider };

  if (skipProviderSetup) {
    // Skip provider/key setup — jump to the rest
    await persistEnv(result);
    await seedUserContext();
    await installMcpServer();
    await interactiveToolConnection();

    console.log();
    console.log('  You\'re all set. Here\'s what to do next:');
    console.log();
    console.log('  plumb status          — see what\'s in your memory');
    console.log('  plumb ingest <file>   — add files or notes to memory');
    console.log('  plumb export          — export everything to markdown');
    console.log();
    return;
  }

  // Select provider
  const provider = await select<Provider>({
    message: 'Select your LLM provider:',
    choices: [
      { name: 'OpenAI (default, recommended)', value: 'openai' },
      { name: 'Anthropic (Claude)', value: 'anthropic' },
      { name: 'Ollama (local)', value: 'ollama' },
      { name: 'OpenAI-compatible (e.g., Together AI)', value: 'openai-compatible' },
    ],
  });

  result = { provider };

  // Handle each provider
  if (provider === 'openai') {
    console.log('\nGet your API key from: https://platform.openai.com/api-keys\n');

    let keyValid = false;
    while (!keyValid) {
      const apiKey = await password({
        message: 'Enter your OpenAI API key:',
        mask: '*',
      });

      if (!apiKey || apiKey.trim() === '') {
        console.error('\nError: API key cannot be empty. Please try again.\n');
        continue;
      }

      result.apiKey = apiKey.trim();

      const spinner = ora('Validating API key...').start();
      keyValid = await validateKey(result);

      if (keyValid) {
        spinner.succeed('API key validated');
      } else {
        spinner.fail('Validation failed — check your key and try again.');
      }
    }
  } else if (provider === 'anthropic') {
    console.log('\nGet your API key from: https://console.anthropic.com/settings/keys\n');

    let keyValid = false;
    while (!keyValid) {
      const apiKey = await password({
        message: 'Enter your Anthropic API key:',
        mask: '*',
      });

      if (!apiKey || apiKey.trim() === '') {
        console.error('\nError: API key cannot be empty. Please try again.\n');
        continue;
      }

      result.apiKey = apiKey.trim();

      const spinner = ora('Validating API key...').start();
      keyValid = await validateKey(result);

      if (keyValid) {
        spinner.succeed('API key validated');
      } else {
        spinner.fail('Validation failed — check your key and try again.');
      }
    }
  } else if (provider === 'ollama') {
    const spinner = ora('Checking if Ollama is running at localhost:11434...').start();

    const ollamaRunning = await validateKey(result);

    if (ollamaRunning) {
      spinner.succeed('Ollama is running and reachable!');
    } else {
      spinner.fail('Ollama is not running or not reachable at localhost:11434');
      console.error('Start Ollama with: ollama serve');
      console.error('Or download from: https://ollama.ai\n');
      process.exit(1);
      return;
    }
  } else if (provider === 'openai-compatible') {
    console.log('\nEnter the base URL for your OpenAI-compatible provider.');
    console.log('Example: https://api.together.xyz/v1\n');

    const baseUrl = await input({
      message: 'Base URL:',
      validate: (value) => {
        if (!value || value.trim() === '') {
          return 'Base URL cannot be empty';
        }
        try {
          new URL(value);
          return true;
        } catch {
          return 'Please enter a valid URL';
        }
      },
    });

    result.baseUrl = baseUrl.trim();

    let keyValid = false;
    while (!keyValid) {
      const apiKey = await password({
        message: 'Enter your API key:',
        mask: '*',
      });

      if (!apiKey || apiKey.trim() === '') {
        console.error('\nError: API key cannot be empty. Please try again.\n');
        continue;
      }

      result.apiKey = apiKey.trim();

      const spinner = ora('Validating API key...').start();
      keyValid = await validateKey(result);

      if (keyValid) {
        spinner.succeed('API key validated');
      } else {
        spinner.fail('Validation failed — check your key and base URL.');
      }
    }
  }

  console.log();

  // Persist to OS environment
  await persistEnv(result);

  // Seed user context with optional personalization questions
  await seedUserContext();

  // Install MCP server if needed
  await installMcpServer();

  // Interactive tool connection with upsell
  await interactiveToolConnection();

  console.log();
  console.log('  You\'re all set. Here\'s what to do next:');
  console.log();
  console.log('  plumb status          — see what\'s in your memory');
  console.log('  plumb ingest <file>   — add files or notes to memory');
  console.log('  plumb export          — export everything to markdown');
  console.log();
}
