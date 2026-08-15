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

  /**
   * Wiki injection mode:
   *   v1         — no wiki behavior (default; safe opt-in)
   *   v2         — full wiki injection: [PLUMB WIKI] block replaces V1 memory injection;
   *                wiki tools (plumb_wiki_read/search/list/links) are registered
   *   v2-shadow  — wiki tools are registered and wiki search runs, but injection stays V1;
   *                use to validate wiki retrieval quality before enabling full v2
   */
  wikiMode?: 'v1' | 'v2' | 'v2-shadow';

  /** Path to the wiki root directory. Defaults to ~/.plumb/wiki */
  wikiRoot?: string;

  /** Path to the wiki SQLite database. Defaults to ~/.plumb/wiki.db */
  wikiDbPath?: string;

  /** E017 opt-in contextual wiki child retrieval. Default mode=off. */
  contextualRetrieval?: {
    mode?: 'off' | 'shadow' | 'active';
    model?: string;
    parentTokenBudgets?: number[];
    maxParentTokens?: number;
  };
}

export const DEFAULT_CONFIG: PlumbPluginConfig = {
  mcpServerPath: 'plumb-mcp',
  userId: 'default',
  enabled: true,
  shadowMode: false,
  wikiMode: 'v1',
};
