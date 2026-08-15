import { join } from 'node:path';
import { homedir } from 'node:os';
import { WikiStore, backfillContextualEmbeddings, DEFAULT_CONTEXTUAL_MODEL } from '@getplumb/core';

export interface WikiContextualBackfillCommandOptions {
  db?: string;
  model?: string;
  limit?: number;
  batchSize?: number;
  verbose?: boolean;
  json?: boolean;
}

export async function wikiContextualBackfillCommand(options: WikiContextualBackfillCommandOptions): Promise<void> {
  const dbPath = options.db ?? join(homedir(), '.plumb', 'wiki.db');
  const model = options.model ?? DEFAULT_CONTEXTUAL_MODEL;
  const store = await WikiStore.create({ dbPath });
  const startedAt = Date.now();
  try {
    const stats = await backfillContextualEmbeddings({
      db: store.db,
      model,
      ...(options.limit !== undefined && { limit: options.limit }),
      ...(options.batchSize !== undefined && { batchSize: options.batchSize }),
      verbose: options.verbose ?? false,
    });
    const result = { ...stats, model, dbPath, elapsedMs: Date.now() - startedAt };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Contextual backfill complete: embedded=${stats.embedded}, skipped=${stats.skipped}, failed=${stats.failed}, scanned=${stats.scanned}, interrupted=${stats.interrupted}`);
      console.log(`Coverage: ${stats.complete}/${stats.totalEligible} (${(stats.coverageRatio * 100).toFixed(1)}%), pending=${stats.pending}, failedRows=${stats.failedRows}, mismatchedDimensions=${stats.mismatchedDimensions}`);
      console.log(`Model: ${model}`);
      console.log(`DB: ${dbPath}`);
    }
  } finally {
    store.close();
  }
}
