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
 * Derives the error log path from the DB path or defaults to ~/.plumb/errors.log.
 */
function getErrorLogPath(dbPath?: string): string {
  if (dbPath) {
    return join(dirname(dbPath), 'errors.log');
  }
  return join(homedir(), '.plumb', 'errors.log');
}

/**
 * Appends an error entry to ~/.plumb/errors.log (or dbPath's parent directory if provided).
 * Format: JSONL (one JSON object per line).
 *
 * This function never throws — if the write fails, it silently logs to console.error only.
 *
 * @param entry  - Error log entry with timestamp, type, message, and optional stack/context
 * @param dbPath - Optional path to the Plumb DB; used to derive the log directory
 */
export function appendError(entry: ErrorLogEntry, dbPath?: string): void {
  try {
    const logPath = getErrorLogPath(dbPath);
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
