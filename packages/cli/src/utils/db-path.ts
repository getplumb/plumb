import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Get the default database path based on PLUMB_ENV.
 *
 * - If PLUMB_ENV=dev, returns ~/.plumb/memory-dev.db
 * - Otherwise, returns ~/.plumb/memory.db (production default)
 *
 * This allows local CLI testing to use a separate dev database
 * without touching the production database held by OpenClaw gateway.
 */
export function getDefaultDbPath(): string {
  const isDevMode = process.env['PLUMB_ENV'] === 'dev';
  const dbFileName = isDevMode ? 'memory-dev.db' : 'memory.db';
  return join(homedir(), '.plumb', dbFileName);
}
