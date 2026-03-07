import { existsSync } from 'node:fs';
import { openDb } from '@getplumb/core';
import { getDefaultDbPath } from '../utils/db-path.js';

export interface HealthOptions {
  /** Path to the database file. Defaults to ~/.plumb/memory.db */
  db?: string;
  /** Print JSON to stdout instead of human-readable format */
  json?: boolean;
  /** User ID to check health for. Defaults to 'default' */
  userId?: string;
}

interface StatusCounts {
  done: number;
  pending: number;
  failed: number;
  no_embed: number;
}

interface HealthResult {
  embed_counts: StatusCounts;
  embed_models: Record<string, number>;
  zero_vectors: number;
  healthy: boolean;
}

/**
 * Query raw_log for embed status counts.
 */
function getEmbedStatusCounts(
  db: Awaited<ReturnType<typeof openDb>>,
  userId: string
): StatusCounts {
  const stmt = db.prepare(`
    SELECT embed_status as status, COUNT(*) as count
    FROM raw_log
    WHERE user_id = ?
    GROUP BY embed_status
  `);
  stmt.bind([userId]);

  const counts: StatusCounts = {
    done: 0,
    pending: 0,
    failed: 0,
    no_embed: 0,
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
    // 1. Get embed pipeline counts
    const embed_counts = getEmbedStatusCounts(db, userId);

    // 2. Get embedding model breakdown
    const embed_models = getEmbedModels(db, userId);

    // 3. Zero-vector detection
    const zero_vectors = getZeroVectorCount(db);

    // Determine if system is healthy
    const healthy =
      embed_counts.pending === 0 &&
      embed_counts.failed === 0 &&
      zero_vectors === 0;

    const result: HealthResult = {
      embed_counts,
      embed_models,
      zero_vectors,
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
      console.log('Embedding Status:');
      console.log(
        `  done=${formatNumber(embed_counts.done)}  pending=${formatNumber(embed_counts.pending)}  failed=${formatNumber(embed_counts.failed)}  no_embed=${formatNumber(embed_counts.no_embed)}`
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

      // Zero vectors
      if (zero_vectors > 0) {
        console.log(`⚠️  Zero vectors detected: ${formatNumber(zero_vectors)} (should be 0)`);
        console.log();
      }

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
