import { LocalStore } from '@getplumb/core';
import { join, basename, relative } from 'node:path';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import type { MessageExchange } from '@getplumb/core';
import { getDefaultDbPath } from '../utils/db-path.js';

export interface IngestOptions {
  /** Path to the database file. Defaults to ~/.plumb/memory.db */
  db?: string;
  /** User ID to ingest data for. Defaults to 'default' */
  userId?: string;
  /** Ingest raw text inline */
  text?: string;
  /** Read from stdin */
  stdin?: boolean;
  /** File path or directory to ingest */
  file?: string;
  /** Dry run mode: preview without writing to DB */
  dryRun?: boolean;
  /** Delay in ms between chunks (default: 0 for dir mode, 800ms for single file) */
  delay?: number;
  /** Concurrency level for processing (default: 1, max: 5) */
  concurrency?: number;
  /** Glob pattern for filtering files in directory mode */
  glob?: string;
}

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
 * Discover files recursively in a directory.
 * Filters for .md, .txt, .json, .jsonl extensions.
 * Skips hidden files/directories (starting with .).
 */
function discoverFiles(dirPath: string, globPattern?: string): string[] {
  const allowedExtensions = ['.md', '.txt', '.json', '.jsonl'];
  const files: string[] = [];

  function traverse(currentPath: string) {
    let entries;
    try {
      entries = readdirSync(currentPath, { withFileTypes: true });
    } catch (err) {
      console.error(`Warning: Cannot read directory ${currentPath}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    for (const entry of entries) {
      // Skip hidden files/directories
      if (entry.name.startsWith('.')) {
        continue;
      }

      const fullPath = join(currentPath, entry.name);

      if (entry.isDirectory()) {
        traverse(fullPath);
      } else if (entry.isFile()) {
        const ext = entry.name.substring(entry.name.lastIndexOf('.')).toLowerCase();
        if (allowedExtensions.includes(ext)) {
          // Apply glob pattern if provided (simple implementation)
          if (globPattern) {
            // Simple glob: just check if filename matches pattern
            // For now, use simple substring matching
            // A full implementation would use minimatch or similar
            if (!entry.name.includes(globPattern.replace(/\*/g, ''))) {
              continue;
            }
          }
          files.push(fullPath);
        }
      }
    }
  }

  traverse(dirPath);

  // Sort for reproducibility
  return files.sort();
}

/**
 * Try to parse a file as JSON/JSONL exchange format.
 * Returns array of MessageExchange objects, or null if parsing fails.
 *
 * JSON format: [{userMessage: '...', agentResponse: '...', timestamp: 'ISO'}]
 * JSONL format: one exchange object per line
 */
function parseExchangeFile(filePath: string): MessageExchange[] | null {
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return null;

    const filename = basename(filePath);

    // Try JSON array first
    if (content.startsWith('[')) {
      try {
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed)) return null;

        const exchanges: MessageExchange[] = [];
        for (const item of parsed) {
          if (typeof item !== 'object' || !item) continue;

          exchanges.push({
            userMessage: String(item.userMessage || ''),
            agentResponse: String(item.agentResponse || ''),
            timestamp: item.timestamp ? new Date(item.timestamp) : new Date(),
            source: 'openclaw',
            sessionId: 'cli-ingest',
            sessionLabel: filename,
          });
        }

        return exchanges.length > 0 ? exchanges : null;
      } catch {
        return null;
      }
    }

    // Try JSONL (one object per line)
    const lines = content.split('\n').filter(line => line.trim());
    const exchanges: MessageExchange[] = [];

    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (typeof item !== 'object' || !item) continue;

        exchanges.push({
          userMessage: String(item.userMessage || ''),
          agentResponse: String(item.agentResponse || ''),
          timestamp: item.timestamp ? new Date(item.timestamp) : new Date(),
          source: 'openclaw',
          sessionId: 'cli-ingest',
          sessionLabel: filename,
        });
      } catch {
        // If any line fails to parse, treat entire file as raw text
        return null;
      }
    }

    return exchanges.length > 0 ? exchanges : null;
  } catch {
    return null;
  }
}

/**
 * Ingest command handler.
 * Modes:
 *   1. plumb ingest <file>             → ingest from file
 *   2. plumb ingest <directory>        → bulk ingest from directory
 *   3. plumb ingest --text 'content'   → ingest raw text inline
 *   4. plumb ingest --stdin            → read from stdin
 */
export async function ingestCommand(options: IngestOptions): Promise<void> {
  const dbPath = options.db ?? getDefaultDbPath();
  const userId = options.userId ?? 'default';
  const isDryRun = options.dryRun ?? false;
  const concurrency = Math.min(Math.max(options.concurrency ?? 1, 1), 5);

  // Determine input mode
  let isDirectoryMode = false;
  let filesToProcess: string[] = [];

  if (options.text) {
    // Mode 1: --text flag (single text input)
    await ingestSingleText(options.text, 'manual', dbPath, userId, options.delay ?? THROTTLE_MS, isDryRun);
    return;
  } else if (options.stdin) {
    // Mode 2: --stdin flag
    if (process.stdin.isTTY) {
      console.error('Error: --stdin flag requires piped input');
      console.error('Example: echo "Some content" | plumb ingest --stdin');
      process.exit(1);
      return;
    }
    const inputText = await readStdin();
    await ingestSingleText(inputText, 'stdin', dbPath, userId, options.delay ?? THROTTLE_MS, isDryRun);
    return;
  } else if (options.file) {
    // Mode 3/4: file or directory path
    if (!existsSync(options.file)) {
      console.error(`Error: Path not found: ${options.file}`);
      process.exit(1);
      return;
    }

    const stats = statSync(options.file);
    if (stats.isDirectory()) {
      // Directory mode
      isDirectoryMode = true;
      filesToProcess = discoverFiles(options.file, options.glob);

      if (filesToProcess.length === 0) {
        console.log('No files found to ingest');
        process.exit(0);
        return;
      }

      console.log(`Found ${filesToProcess.length} file${filesToProcess.length !== 1 ? 's' : ''} to ingest${isDryRun ? ' (dry run)' : ''}`);
      console.log();
    } else {
      // Single file mode
      filesToProcess = [options.file];
    }
  } else {
    // No input provided
    console.error('Error: No input provided');
    console.error('Usage:');
    console.error('  plumb ingest <file>');
    console.error('  plumb ingest <directory>');
    console.error('  plumb ingest --text "Some content"');
    console.error('  echo "content" | plumb ingest --stdin');
    process.exit(1);
    return;
  }

  // Process files (directory or single file)
  await ingestFiles(filesToProcess, dbPath, userId, {
    delay: options.delay ?? (isDirectoryMode ? 0 : THROTTLE_MS),
    isDryRun,
    isDirectoryMode,
  });
}

/**
 * Ingest a single text string (for --text or --stdin mode).
 */
async function ingestSingleText(
  inputText: string,
  sourceLabel: string,
  dbPath: string,
  userId: string,
  delay: number,
  isDryRun: boolean,
): Promise<void> {
  if (!inputText.trim()) {
    console.log('Nothing to ingest');
    process.exit(0);
    return;
  }

  const chunks = chunkText(inputText);

  if (chunks.length === 0) {
    console.log('Nothing to ingest (all chunks too small)');
    process.exit(0);
    return;
  }

  if (isDryRun) {
    console.log(`[DRY RUN] Would ingest ${chunks.length} chunk${chunks.length !== 1 ? 's' : ''} from ${sourceLabel}`);
    console.log();
    for (let i = 0; i < chunks.length; i++) {
      console.log(`[${i + 1}/${chunks.length}] ${chunks[i]?.substring(0, 80)}...`);
    }
    return;
  }

  const store = await LocalStore.create({ dbPath, userId });
  const initialStatus = await store.status();
  const initialFactCount = initialStatus.factCount;

  console.log(`Ingesting ${chunks.length} chunk${chunks.length !== 1 ? 's' : ''} from ${sourceLabel}...`);
  console.log();

  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

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

    if (i < chunks.length - 1) {
      await sleep(delay);
    }
  }

  console.log();
  console.log('Waiting for fact extraction to complete...');
  await store.drain();

  const finalStatus = await store.status();
  const finalFactCount = finalStatus.factCount;
  const factsExtracted = finalFactCount - initialFactCount;

  store.close();

  console.log();
  console.log('Summary:');
  console.log(`  Chunks ingested:    ${ingested}`);
  console.log(`  Chunks skipped:     ${skipped}`);
  console.log(`  Errors:             ${errors}`);
  console.log(`  Facts extracted:    ${factsExtracted}`);
  console.log();

  if (errors > 0) {
    process.exit(1);
  }
}

/**
 * Ingest multiple files (directory mode or single file).
 */
async function ingestFiles(
  files: string[],
  dbPath: string,
  userId: string,
  options: { delay: number; isDryRun: boolean; isDirectoryMode: boolean },
): Promise<void> {
  const { delay, isDryRun, isDirectoryMode } = options;

  // For dry run, just preview
  if (isDryRun) {
    console.log(`[DRY RUN] Would process ${files.length} file${files.length !== 1 ? 's' : ''}:`);
    console.log();
    for (let i = 0; i < files.length; i++) {
      console.log(`[${i + 1}/${files.length}] ${files[i]}`);
    }
    return;
  }

  const store = await LocalStore.create({ dbPath, userId });
  const initialStatus = await store.status();
  const initialFactCount = initialStatus.factCount;

  let totalIngested = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let filesProcessed = 0;
  let filesWithErrors = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const filePath = files[fileIdx];
    if (!filePath) continue;

    const fileProgress = isDirectoryMode ? `[${fileIdx + 1}/${files.length}] ` : '';
    console.log(`${fileProgress}Ingesting ${filePath}...`);

    try {
      // Try to parse as JSON/JSONL exchange format first
      const exchanges = parseExchangeFile(filePath);

      if (exchanges && exchanges.length > 0) {
        // Process as structured exchanges
        for (let i = 0; i < exchanges.length; i++) {
          const exchange = exchanges[i];
          if (!exchange) continue;

          try {
            const result = await store.ingest(exchange);
            if (result.skipped) {
              totalSkipped++;
            } else {
              totalIngested++;
            }
          } catch (err: unknown) {
            totalErrors++;
            console.error(`  Error ingesting exchange ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
          }

          if (i < exchanges.length - 1 && delay > 0) {
            await sleep(delay);
          }
        }
        console.log(`  Processed ${exchanges.length} exchange${exchanges.length !== 1 ? 's' : ''}`);
      } else {
        // Fall back to raw text chunking
        const content = readFileSync(filePath, 'utf-8');
        const chunks = chunkText(content);

        if (chunks.length === 0) {
          console.log(`  Skipped (no chunks >= ${MIN_CHUNK_CHARS} chars)`);
          filesProcessed++;
          continue;
        }

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (!chunk) continue;

          try {
            const exchange: MessageExchange = {
              userMessage: '',
              agentResponse: chunk,
              timestamp: new Date(),
              source: 'openclaw',
              sessionId: 'cli-ingest',
              sessionLabel: basename(filePath),
            };

            const result = await store.ingest(exchange);
            if (result.skipped) {
              totalSkipped++;
            } else {
              totalIngested++;
            }
          } catch (err: unknown) {
            totalErrors++;
            console.error(`  Error ingesting chunk ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
          }

          if (i < chunks.length - 1 && delay > 0) {
            await sleep(delay);
          }
        }
        console.log(`  Processed ${chunks.length} chunk${chunks.length !== 1 ? 's' : ''}`);
      }

      filesProcessed++;
    } catch (err: unknown) {
      filesWithErrors++;
      totalErrors++;
      console.error(`  Error processing file: ${err instanceof Error ? err.message : String(err)}`);
    }

    console.log();
  }

  console.log('Waiting for fact extraction to complete...');
  await store.drain();

  const finalStatus = await store.status();
  const finalFactCount = finalStatus.factCount;
  const factsExtracted = finalFactCount - initialFactCount;

  store.close();

  console.log();
  console.log('Summary:');
  console.log(`  Files processed:    ${filesProcessed}`);
  if (filesWithErrors > 0) {
    console.log(`  Files with errors:  ${filesWithErrors}`);
  }
  console.log(`  Chunks ingested:    ${totalIngested}`);
  console.log(`  Chunks skipped:     ${totalSkipped} (duplicates)`);
  console.log(`  Errors:             ${totalErrors}`);
  console.log(`  Facts extracted:    ${factsExtracted}`);
  console.log();

  if (totalErrors > 0) {
    process.exit(1);
  }
}
