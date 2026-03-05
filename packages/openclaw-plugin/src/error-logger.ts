import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';

export interface ErrorLogEntry {
  timestamp: string;
  type: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

/**
 * Derives the error log path from the DB path (if set) or defaults to ~/.plumb/errors.log.
 * If PLUMB_DB_PATH environment variable is set, we use its parent directory.
 */
function getErrorLogPath(): string {
  const dbPath = process.env.PLUMB_DB_PATH;

  if (dbPath) {
    // Use the parent directory of the DB path
    return join(dirname(dbPath), 'errors.log');
  }

  // Default: ~/.plumb/errors.log
  return join(homedir(), '.plumb', 'errors.log');
}

/**
 * Appends an error entry to ~/.plumb/errors.log (or PLUMB_DB_PATH parent if set).
 * Format: JSONL (one JSON object per line).
 *
 * This function never throws — if the write fails, it silently logs to console.error only.
 *
 * @param entry - Error log entry with timestamp, type, message, and optional stack/context
 */
export function appendError(entry: ErrorLogEntry): void {
  try {
    const logPath = getErrorLogPath();
    const logDir = dirname(logPath);

    // Ensure directory exists
    mkdirSync(logDir, { recursive: true });

    // Write JSONL: one JSON object per line
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(logPath, line, 'utf-8');
  } catch (err: unknown) {
    // Non-blocking: if the log write itself fails, just console.error
    console.error('[plumb/error-logger] Failed to write error log:', err);
  }
}
