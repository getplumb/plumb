import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PlumbConfig {
  readonly userId: string;
  readonly dbPath: string;
  readonly wikiRoot: string;
  readonly wikiDbPath: string;
  readonly wikiQueuePath: string;
}

function expandTilde(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}

/**
 * Resolve configuration from CLI flags and environment variables.
 * Resolution order (highest priority wins): CLI flag > env var > default
 *
 * Defaults:
 *   userId: 'default'
 *   dbPath: ~/.plumb/memory.db
 *   wikiRoot: ~/.plumb/wiki
 *   wikiDbPath: ~/.plumb/wiki.db
 *   wikiQueuePath: ~/.plumb/wiki-queue.jsonl
 *
 * Environment variables:
 *   PLUMB_USER_ID — sets the userId
 *   PLUMB_DB_PATH — sets the memory DB path
 *   PLUMB_WIKI_ROOT — sets the wiki root directory
 *   PLUMB_WIKI_DB_PATH — sets the wiki DB path
 *   PLUMB_WIKI_QUEUE_PATH — sets the wiki edit queue JSONL path
 *
 * CLI flags:
 *   --user-id <id>       sets userId
 *   --db <path>          sets memory DB path
 *   --wiki-root <path>   sets wiki root directory
 *   --wiki-db <path>     sets wiki DB path
 *   --wiki-queue <path>  sets wiki edit queue JSONL path
 */
export function resolveConfig(args: readonly string[] = process.argv.slice(2), env = process.env): PlumbConfig {
  // Defaults
  const defaultUserId = 'default';
  const defaultDbPath = join(homedir(), '.plumb', 'memory.db');
  const defaultWikiRoot = join(homedir(), '.plumb', 'wiki');
  const defaultWikiDbPath = join(homedir(), '.plumb', 'wiki.db');
  const defaultWikiQueuePath = join(homedir(), '.plumb', 'wiki-queue.jsonl');

  // Read from environment variables
  let userId = env['PLUMB_USER_ID'] ?? defaultUserId;
  let dbPath = env['PLUMB_DB_PATH'] ?? defaultDbPath;
  let wikiRoot = env['PLUMB_WIKI_ROOT'] ?? defaultWikiRoot;
  let wikiDbPath = env['PLUMB_WIKI_DB_PATH'] ?? defaultWikiDbPath;
  let wikiQueuePath = env['PLUMB_WIKI_QUEUE_PATH'] ?? defaultWikiQueuePath;

  // Parse CLI flags (override environment)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user-id' && args[i + 1] !== undefined) {
      userId = args[++i] as string;
    } else if (args[i] === '--db' && args[i + 1] !== undefined) {
      dbPath = args[++i] as string;
    } else if (args[i] === '--wiki-root' && args[i + 1] !== undefined) {
      wikiRoot = args[++i] as string;
    } else if (args[i] === '--wiki-db' && args[i + 1] !== undefined) {
      wikiDbPath = args[++i] as string;
    } else if (args[i] === '--wiki-queue' && args[i + 1] !== undefined) {
      wikiQueuePath = args[++i] as string;
    }
  }

  return {
    userId,
    dbPath: expandTilde(dbPath),
    wikiRoot: expandTilde(wikiRoot),
    wikiDbPath: expandTilde(wikiDbPath),
    wikiQueuePath: expandTilde(wikiQueuePath),
  };
}
