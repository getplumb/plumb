export interface PlumbPluginConfig {
  /** Path to the @plumb/mcp-server binary (e.g. node_modules/.bin/plumb-mcp). */
  mcpServerPath: string;

  /** User identifier for multi-user setups. */
  userId: string;

  /** Whether the plugin is active. */
  enabled: boolean;

  /** Path to the Plumb database file. If not provided, defaults to ~/.plumb/memory.db */
  dbPath?: string;

  /** If true: retrieve but don't inject (for validation). Default: false. */
  shadowMode: boolean;

  /** LLM provider for fact extraction: 'openai', 'anthropic', 'ollama', 'openai-compatible'. */
  llmProvider?: string;

  /** LLM model ID for fact extraction. Defaults vary by provider. */
  llmModel?: string;

  /** API key for LLM provider. Overrides env vars when set. */
  llmApiKey?: string;
}

export const DEFAULT_CONFIG: PlumbPluginConfig = {
  mcpServerPath: 'plumb-mcp',
  userId: 'default',
  enabled: true,
  shadowMode: false,
};
