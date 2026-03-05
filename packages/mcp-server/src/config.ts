import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PlumbConfig {
  readonly userId: string;
  readonly dbPath: string;
}

/**
 * Resolve configuration from CLI flags and environment variables.
 * Resolution order (highest priority wins): CLI flag > env var > default
 *
 * Defaults:
 *   userId: 'default'
 *   dbPath: ~/.plumb/memory.db
 *
 * Environment variables:
 *   PLUMB_USER_ID — sets the userId
 *   PLUMB_DB_PATH — sets the DB path
 *
 * CLI flags:
 *   --user-id <id>     sets userId
 *   --db <path>        sets DB path
 */
export function resolveConfig(args: readonly string[] = process.argv.slice(2), env = process.env): PlumbConfig {
  // Defaults
  const defaultUserId = 'default';
  const defaultDbPath = join(homedir(), '.plumb', 'memory.db');

  // Read from environment variables
  let userId = env['PLUMB_USER_ID'] ?? defaultUserId;
  let dbPath = env['PLUMB_DB_PATH'] ?? defaultDbPath;

  // Parse CLI flags (override environment)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user-id' && args[i + 1] !== undefined) {
      userId = args[++i] as string;
    } else if (args[i] === '--db' && args[i + 1] !== undefined) {
      dbPath = args[++i] as string;
    }
  }

  // Expand tilde in dbPath
  if (dbPath.startsWith('~/')) {
    dbPath = join(homedir(), dbPath.slice(2));
  } else if (dbPath === '~') {
    dbPath = homedir();
  }

  return { userId, dbPath };
}
