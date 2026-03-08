import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

/**
 * Manages the one-time orientation message shown to the agent on first Plumb activation.
 * Uses the existing nudge_log table with trigger_type='first_activation'.
 */
export class OrientationManager {
  /**
   * Check if the orientation has already been fired.
   * @param db Database instance
   * @returns true if orientation has already been shown, false otherwise
   */
  hasOrientationFired(db: Database.Database): boolean {
    const row = db
      .prepare<[string], { id: string }>(
        `SELECT id FROM nudge_log WHERE trigger_type = ?`
      )
      .get('first_activation');
    return row !== undefined;
  }

  /**
   * Record that the orientation has been fired.
   * Inserts a row into nudge_log with trigger_type='first_activation'.
   * @param db Database instance
   */
  recordOrientation(db: Database.Database): void {
    const id = randomUUID();
    const firedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO nudge_log (id, trigger_type, fired_at) VALUES (?, ?, ?)`
    ).run(id, 'first_activation', firedAt);
  }

  /**
   * Get the orientation text to inject into the agent's context.
   * Expands ~ in dbPath to the user's home directory.
   * @param dbPath Path to the Plumb database (may contain ~)
   * @returns Formatted orientation text
   */
  getOrientationText(dbPath: string): string {
    // Expand ~ to full home directory path
    const resolvedPath = dbPath.startsWith('~')
      ? dbPath.replace('~', homedir())
      : dbPath;

    return `[PLUMB MEMORY — First activation]
Plumb is now active. Memory is retrieved automatically and injected before each response.

Tools available to you:
- plumb_remember("fact") — store something worth keeping across sessions
- plumb_search("query") — search memory mid-reasoning for a specific topic

Memory is written to: ${resolvedPath}

Daily backup convention:
- At the end of a session with significant events or decisions, write a brief summary to memory/YYYY-MM-DD.md (relative to your workspace root)
- This is a human-readable logbook for review — NOT a memory source (Plumb handles retrieval)
- Keep it dense: decisions made, facts learned, tasks completed — not a transcript

If your AGENTS.md or MEMORY.md don't already reference Plumb, you may want to update them so future sessions start with the right mental model.
[/PLUMB MEMORY]`;
  }
}
