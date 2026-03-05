import { LocalStore } from '@getplumb/core';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { MessageExchange } from '@getplumb/core';

export interface IngestOptions {
  /** Path to the database file. Defaults to ~/.plumb/memory.db */
  db?: string;
  /** User ID to ingest data for. Defaults to 'default' */
  userId?: string;
  /** Ingest raw text inline */
  text?: string;
  /** Read from stdin */
  stdin?: boolean;
  /** File path to ingest */
  file?: string;
}

const DEFAULT_DB_PATH = join(homedir(), '.plumb', 'memory.db');
const THROTTLE_MS = 800;  // Delay between ingests to avoid rate limits
const MIN_CHUNK_CHARS = 100;  // Skip chunks smaller than this

/**
 * Split text into chunks on paragraph boundaries (double newline).
 * Filters out chunks smaller than MIN_CHUNK_CHARS.
 */
function chunkText(text: string): string[] {
  // Split on double newline (paragraph boundaries)
  const paragraphs = text.split(/\n\n+/);

  const chunks: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    // Keep chunks that are at least MIN_CHUNK_CHARS
    if (trimmed.length >= MIN_CHUNK_CHARS) {
      chunks.push(trimmed);
    }
  }

  return chunks;
}

/**
 * Sleep helper for throttling.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read from stdin (async).
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    process.stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    process.stdin.on('error', (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Ingest command handler.
 * Three modes:
 *   1. plumb ingest <file>           → ingest from file
 *   2. plumb ingest --text 'content' → ingest raw text inline
 *   3. plumb ingest --stdin          → read from stdin
 */
export async function ingestCommand(options: IngestOptions): Promise<void> {
  const dbPath = options.db ?? DEFAULT_DB_PATH;
  const userId = options.userId ?? 'default';

  // Determine input mode and source label
  let inputText: string;
  let sourceLabel: string;

  if (options.text) {
    // Mode 1: --text flag
    inputText = options.text;
    sourceLabel = 'manual';
  } else if (options.stdin) {
    // Mode 2: --stdin flag
    if (process.stdin.isTTY) {
      console.error('Error: --stdin flag requires piped input');
      console.error('Example: echo "Some content" | plumb ingest --stdin');
      process.exit(1);
      return;
    }
    inputText = await readStdin();
    sourceLabel = 'stdin';
  } else if (options.file) {
    // Mode 3: file path argument
    if (!existsSync(options.file)) {
      console.error(`Error: File not found: ${options.file}`);
      process.exit(1);
      return;
    }
    inputText = readFileSync(options.file, 'utf-8');
    sourceLabel = options.file;
  } else {
    // No input provided
    console.error('Error: No input provided');
    console.error('Usage:');
    console.error('  plumb ingest <file>');
    console.error('  plumb ingest --text "Some content"');
    console.error('  echo "content" | plumb ingest --stdin');
    process.exit(1);
    return;
  }

  // Handle empty input
  if (!inputText.trim()) {
    console.log('Nothing to ingest');
    process.exit(0);
    return;
  }

  // Chunk the input text
  const chunks = chunkText(inputText);

  if (chunks.length === 0) {
    console.log('Nothing to ingest (all chunks too small)');
    process.exit(0);
    return;
  }

  // Open LocalStore
  const store = new LocalStore({ dbPath, userId });

  // Get initial fact count (for summary)
  const initialStatus = await store.status();
  const initialFactCount = initialStatus.factCount;

  console.log(`Ingesting ${chunks.length} chunk${chunks.length !== 1 ? 's' : ''} from ${sourceLabel}...`);
  console.log();

  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  // Ingest each chunk
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue; // Type guard

    const progress = `[${i + 1}/${chunks.length}]`;

    try {
      const exchange: MessageExchange = {
        userMessage: '',
        agentResponse: chunk,
        timestamp: new Date(),
        source: 'openclaw',
        sessionId: 'cli-ingest',
        sessionLabel: sourceLabel,
      };

      const result = await store.ingest(exchange);

      if (result.skipped) {
        skipped++;
        console.log(`${progress} Skipped chunk ${i + 1} (duplicate)`);
      } else {
        ingested++;
        console.log(`${progress} Ingested chunk ${i + 1}`);
      }
    } catch (err: unknown) {
      errors++;
      console.error(`${progress} Failed to ingest chunk ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Throttle between ingests (skip delay after last chunk)
    if (i < chunks.length - 1) {
      await sleep(THROTTLE_MS);
    }
  }

  console.log();
  console.log('Waiting for fact extraction to complete...');

  // Wait for all in-flight fact extractions to complete
  await store.drain();

  // Get final fact count
  const finalStatus = await store.status();
  const finalFactCount = finalStatus.factCount;
  const factsExtracted = finalFactCount - initialFactCount;

  store.close();

  // Print summary
  console.log();
  console.log('Summary:');
  console.log(`  Chunks ingested:    ${ingested}`);
  console.log(`  Chunks skipped:     ${skipped}`);
  console.log(`  Errors:             ${errors}`);
  console.log(`  Facts extracted:    ${factsExtracted}`);
  console.log();

  // Exit with error code if there were errors
  if (errors > 0) {
    process.exit(1);
    return;
  }
}
