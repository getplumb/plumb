import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { openDb } from '@getplumb/core';
import { callLLMWithConfig, type LLMConfig } from '@getplumb/core';
import { getDefaultDbPath } from '../utils/db-path.js';

export interface HealthOptions {
  /** Path to the database file. Defaults to ~/.plumb/memory.db */
  db?: string;
  /** Print JSON to stdout instead of human-readable format */
  json?: boolean;
  /** User ID to check health for. Defaults to 'default' */
  userId?: string;
  /** Skip API key validation test */
  skipApiTest?: boolean;
}

const DEFAULT_CONFIG_PATH = join(homedir(), '.plumb', 'config.json');

interface StatusCounts {
  done: number;
  pending: number;
  failed: number;
  skipped: number;
  no_llm: number;
}

interface HealthResult {
  embed_counts: StatusCounts;
  extract_counts: StatusCounts;
  embed_models: Record<string, number>;
  zero_vectors: number;
  facts: {
    total: number;
    deleted: number;
    with_chunk_id: number;
    without_chunk_id: number;
    last_extraction: string | null;
  };
  llm_config: {
    provider: string;
    model: string;
    valid: boolean;
    error?: string;
  };
  healthy: boolean;
}

/**
 * Read LLM config from environment variables or config file.
 * Priority: env vars > config.json
 */
function readLLMConfig(): LLMConfig {
  const config: LLMConfig = {};

  // Try reading from config.json
  if (existsSync(DEFAULT_CONFIG_PATH)) {
    try {
      const configJson = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf-8'));
      if (configJson.provider) config.provider = configJson.provider;
      if (configJson.model) config.model = configJson.model;
      if (configJson.apiKey) config.apiKey = configJson.apiKey;
      if (configJson.baseUrl) config.baseUrl = configJson.baseUrl;
    } catch {
      // Ignore parse errors, fall back to env vars
    }
  }

  // Env vars override config.json
  if (process.env['PLUMB_LLM_PROVIDER']) {
    config.provider = process.env['PLUMB_LLM_PROVIDER'];
  }
  if (process.env['PLUMB_LLM_MODEL']) {
    config.model = process.env['PLUMB_LLM_MODEL'];
  }
  if (process.env['OPENAI_API_KEY']) {
    config.apiKey = process.env['OPENAI_API_KEY'];
  }
  if (process.env['ANTHROPIC_API_KEY']) {
    config.apiKey = process.env['ANTHROPIC_API_KEY'];
  }
  if (process.env['GEMINI_API_KEY']) {
    config.apiKey = process.env['GEMINI_API_KEY'];
  }
  if (process.env['PLUMB_LLM_BASE_URL']) {
    config.baseUrl = process.env['PLUMB_LLM_BASE_URL'];
  }

  // Defaults
  if (!config.provider) config.provider = 'openai';
  if (!config.model) {
    const defaults: Record<string, string> = {
      openai: 'gpt-4o-mini',
      anthropic: 'claude-haiku-4-5-20251001',
      ollama: 'llama3.1',
      google: 'gemini-2.5-flash-lite',
      'openai-compatible': 'gpt-4o-mini',
    };
    config.model = defaults[config.provider] ?? 'gpt-4o-mini';
  }

  return config;
}

/**
 * Validate LLM API key by making a minimal test call.
 */
async function validateLLMConfig(
  config: LLMConfig
): Promise<{ valid: boolean; error?: string }> {
  try {
    await callLLMWithConfig('Say OK', config);
    return { valid: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: message };
  }
}

/**
 * Query raw_log for status counts.
 */
function getStatusCounts(
  db: Awaited<ReturnType<typeof openDb>>,
  userId: string,
  column: 'embed_status' | 'extract_status'
): StatusCounts {
  const stmt = db.prepare(`
    SELECT ${column} as status, COUNT(*) as count
    FROM raw_log
    WHERE user_id = ?
    GROUP BY ${column}
  `);
  stmt.bind([userId]);

  const counts: StatusCounts = {
    done: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
    no_llm: 0,
  };

  while (stmt.step()) {
    const row = stmt.get({}) as { status: string; count: number };
    const status = row.status as keyof StatusCounts;
    if (status in counts) {
      counts[status] = row.count;
    }
  }
  stmt.finalize();

  return counts;
}

/**
 * Query raw_log for embedding model breakdown.
 */
function getEmbedModels(
  db: Awaited<ReturnType<typeof openDb>>,
  userId: string
): Record<string, number> {
  const stmt = db.prepare(`
    SELECT embed_model, COUNT(*) as count
    FROM raw_log
    WHERE user_id = ? AND embed_model IS NOT NULL
    GROUP BY embed_model
  `);
  stmt.bind([userId]);

  const models: Record<string, number> = {};
  while (stmt.step()) {
    const row = stmt.get({}) as { embed_model: string; count: number };
    models[row.embed_model] = row.count;
  }
  stmt.finalize();

  return models;
}

/**
 * Detect zero-vector embeddings in vec_raw_log.
 * A vector is considered zero if both first and last dimensions are exactly 0.0.
 */
function getZeroVectorCount(db: Awaited<ReturnType<typeof openDb>>): number {
  const stmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM vec_raw_log
    WHERE json_extract(embedding, '$[0]') = 0.0
      AND json_extract(embedding, '$[383]') = 0.0
  `);

  stmt.step();
  const row = stmt.get({}) as { count: number } | null;
  stmt.finalize();

  return row?.count ?? 0;
}

/**
 * Get facts health statistics.
 */
function getFactsHealth(
  db: Awaited<ReturnType<typeof openDb>>,
  userId: string
): HealthResult['facts'] {
  // Total facts
  const totalStmt = db.prepare('SELECT COUNT(*) as count FROM facts WHERE user_id = ?');
  totalStmt.bind([userId]);
  totalStmt.step();
  const totalRow = totalStmt.get({}) as { count: number } | null;
  const total = totalRow?.count ?? 0;
  totalStmt.finalize();

  // Deleted facts
  const deletedStmt = db.prepare('SELECT COUNT(*) as count FROM facts WHERE user_id = ? AND deleted_at IS NOT NULL');
  deletedStmt.bind([userId]);
  deletedStmt.step();
  const deletedRow = deletedStmt.get({}) as { count: number } | null;
  const deleted = deletedRow?.count ?? 0;
  deletedStmt.finalize();

  // With source_chunk_id
  const withChunkStmt = db.prepare('SELECT COUNT(*) as count FROM facts WHERE user_id = ? AND source_chunk_id IS NOT NULL');
  withChunkStmt.bind([userId]);
  withChunkStmt.step();
  const withChunkRow = withChunkStmt.get({}) as { count: number } | null;
  const with_chunk_id = withChunkRow?.count ?? 0;
  withChunkStmt.finalize();

  // Without source_chunk_id
  const without_chunk_id = total - with_chunk_id;

  // Last extraction timestamp
  const lastExtractionStmt = db.prepare(`
    SELECT MAX(timestamp) as last_timestamp
    FROM facts
    WHERE user_id = ? AND deleted_at IS NULL
  `);
  lastExtractionStmt.bind([userId]);
  lastExtractionStmt.step();
  const lastExtractionRow = lastExtractionStmt.get({}) as { last_timestamp: string | null } | null;
  const last_extraction = lastExtractionRow?.last_timestamp ?? null;
  lastExtractionStmt.finalize();

  return {
    total,
    deleted,
    with_chunk_id,
    without_chunk_id,
    last_extraction,
  };
}

/**
 * Format number with thousands separator.
 */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Health command handler.
 */
export async function healthCommand(options: HealthOptions): Promise<void> {
  const dbPath = options.db ?? getDefaultDbPath();
  const userId = options.userId ?? 'default';

  // Check if database exists
  if (!existsSync(dbPath)) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            error: 'Database not found',
            path: dbPath,
            healthy: false,
          },
          null,
          2
        )
      );
    } else {
      console.error(`Error: Database not found at ${dbPath}`);
      console.error('No Plumb data found. Start using Plumb to build your memory.');
    }
    process.exit(1);
  }

  // Open database
  const db = await openDb(dbPath);

  try {
    // 1. Get pipeline counts
    const embed_counts = getStatusCounts(db, userId, 'embed_status');
    const extract_counts = getStatusCounts(db, userId, 'extract_status');

    // 2. Get embedding model breakdown
    const embed_models = getEmbedModels(db, userId);

    // 3. LLM config validity
    const config = readLLMConfig();
    let llm_config: HealthResult['llm_config'];

    if (options.skipApiTest) {
      llm_config = {
        provider: config.provider ?? 'openai',
        model: config.model ?? 'unknown',
        valid: true, // Assume valid if skipping test
      };
    } else {
      const validation = await validateLLMConfig(config);
      llm_config = {
        provider: config.provider ?? 'openai',
        model: config.model ?? 'unknown',
        valid: validation.valid,
        ...(validation.error ? { error: validation.error } : {}),
      };
    }

    // 4. Zero-vector detection
    const zero_vectors = getZeroVectorCount(db);

    // 5. Facts health
    const facts = getFactsHealth(db, userId);

    // Determine if system is healthy
    const healthy =
      embed_counts.pending === 0 &&
      embed_counts.failed === 0 &&
      extract_counts.pending === 0 &&
      extract_counts.failed === 0 &&
      zero_vectors === 0;

    const result: HealthResult = {
      embed_counts,
      extract_counts,
      embed_models,
      zero_vectors,
      facts,
      llm_config,
      healthy,
    };

    // Output
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      // Human-readable output
      console.log('Plumb Health Check');
      console.log('──────────────────────────────────────');
      console.log();

      // Pipeline counts
      console.log('Pipeline Status:');
      console.log(
        `  Embedding:  done=${formatNumber(embed_counts.done)}  pending=${formatNumber(embed_counts.pending)}  failed=${formatNumber(embed_counts.failed)}  skipped=${formatNumber(embed_counts.skipped)}  no_llm=${formatNumber(embed_counts.no_llm)}`
      );
      console.log(
        `  Extraction: done=${formatNumber(extract_counts.done)}  pending=${formatNumber(extract_counts.pending)}  failed=${formatNumber(extract_counts.failed)}  skipped=${formatNumber(extract_counts.skipped)}  no_llm=${formatNumber(extract_counts.no_llm)}`
      );
      console.log();

      // Embedding model breakdown
      if (Object.keys(embed_models).length > 0) {
        console.log('Embedding Models:');
        for (const [model, count] of Object.entries(embed_models)) {
          console.log(`  ${model}: ${formatNumber(count)} chunks`);
        }
        console.log();
      }

      // LLM config
      const llmStatus = llm_config.valid ? 'OK' : `FAILED (${llm_config.error})`;
      const skipNote = options.skipApiTest ? ' (not tested)' : '';
      console.log(`LLM config: ${llm_config.provider}/${llm_config.model} ${llmStatus}${skipNote}`);
      console.log();

      // Zero vectors
      if (zero_vectors > 0) {
        console.log(`⚠️  Zero vectors detected: ${formatNumber(zero_vectors)} (should be 0)`);
        console.log();
      }

      // Facts health
      console.log('Facts:');
      console.log(`  Total:            ${formatNumber(facts.total)}`);
      console.log(`  Deleted:          ${formatNumber(facts.deleted)}`);
      console.log(`  With chunk ID:    ${formatNumber(facts.with_chunk_id)}`);
      console.log(`  Without chunk ID: ${formatNumber(facts.without_chunk_id)}`);
      if (facts.last_extraction) {
        const lastDate = new Date(facts.last_extraction);
        console.log(`  Last extraction:  ${lastDate.toLocaleString()}`);
      }
      console.log();

      // Overall health
      if (healthy) {
        console.log('✓ System is healthy');
      } else {
        console.log('✗ Issues detected:');
        if (embed_counts.pending > 0) {
          console.log(`  - ${formatNumber(embed_counts.pending)} chunks pending embedding`);
        }
        if (embed_counts.failed > 0) {
          console.log(`  - ${formatNumber(embed_counts.failed)} chunks failed embedding`);
        }
        if (extract_counts.pending > 0) {
          console.log(`  - ${formatNumber(extract_counts.pending)} chunks pending extraction`);
        }
        if (extract_counts.failed > 0) {
          console.log(`  - ${formatNumber(extract_counts.failed)} chunks failed extraction`);
        }
        if (zero_vectors > 0) {
          console.log(`  - ${formatNumber(zero_vectors)} zero-vector embeddings`);
        }
      }
    }

    db.close();

    // Exit with appropriate code
    process.exit(healthy ? 0 : 1);
  } catch (err: unknown) {
    db.close();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Health check failed: ${message}`);
    process.exit(1);
  }
}
