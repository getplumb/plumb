import { randomUUID } from 'node:crypto';

export type NudgeTriggerType = 'second_integration' | 'mcp_downtime';

// Type alias for better-sqlite3 Database to avoid direct import
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Database = any;

/**
 * Manages one-time contextual upgrade nudges to the user.
 * Each trigger type fires exactly once per install, tracked in the nudge_log table.
 */
export class NudgeManager {
  /** Track which sessions have been seen this runtime to avoid redundant checks */
  private seenSessions: Set<string> = new Set();

  /** Track MCP downtime start timestamp (in-memory, not persisted) */
  private mcpDowntimeStart: number | null = null;

  /** Threshold in milliseconds for MCP downtime trigger (5 minutes) */
  private readonly MCP_DOWNTIME_THRESHOLD_MS = 5 * 60 * 1000;

  /**
   * Check if a nudge should be fired for the given trigger type.
   * Returns the nudge text if it should fire, null otherwise.
   */
  checkTriggers(db: Database, triggerType: NudgeTriggerType): string | null {
    // Check if this trigger has already fired (check nudge_log table)
    const existing = db.prepare(
      `SELECT id FROM nudge_log WHERE trigger_type = ? LIMIT 1`
    ).get(triggerType);

    if (existing) {
      // This trigger has already fired — never fire again
      return null;
    }

    // Trigger has not fired yet — return the nudge text
    return this.getNudgeText(triggerType);
  }

  /**
   * Record that a nudge has been fired for the given trigger type.
   * This ensures the trigger will never fire again.
   */
  recordNudge(db: Database, triggerType: NudgeTriggerType): void {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO nudge_log (id, trigger_type, fired_at) VALUES (?, ?, ?)`
    ).run(id, triggerType, new Date().toISOString());
  }

  /**
   * Get the nudge text for a given trigger type.
   * Tone: factual, helpful, not pushy. Surfaced through the agent's voice.
   */
  getNudgeText(triggerType: NudgeTriggerType): string {
    switch (triggerType) {
      case 'second_integration':
        return "You've connected multiple integrations - if you want memory to sync across all of them automatically, Plumb hosted handles that: https://getplumb.dev/upgrade";
      case 'mcp_downtime':
        return 'Your local MCP server has been unreachable for a while - Plumb hosted runs in the cloud and stays available 24/7: https://getplumb.dev/upgrade';
      default:
        return '';
    }
  }

  /**
   * Check if the 'second_integration' trigger should fire.
   * Counts distinct session_ids in raw_log for this userId.
   * If >1 unique session has ingested data, that's a second integration.
   *
   * Only checks once per session to avoid redundant queries.
   */
  checkSecondIntegration(
    db: Database,
    userId: string,
    currentSessionId: string
  ): string | null {
    // Only check once per session
    if (this.seenSessions.has(currentSessionId)) {
      return null;
    }
    this.seenSessions.add(currentSessionId);

    // Count distinct session_ids in raw_log for this user
    const result = db.prepare(
      `SELECT COUNT(DISTINCT session_id) as count FROM raw_log WHERE user_id = ?`
    ).get(userId);

    const sessionCount = result?.count ?? 0;

    if (sessionCount > 1) {
      // Multiple sessions detected — check if we should fire the nudge
      return this.checkTriggers(db, 'second_integration');
    }

    return null;
  }

  /**
   * Trigger the MCP downtime nudge.
   * Called when MCP client connection fails.
   * Tracks downtime duration in-memory; fires if >5 minutes.
   */
  triggerMcpDowntime(db: Database): string | null {
    const now = Date.now();

    // Start tracking downtime if not already started
    if (this.mcpDowntimeStart === null) {
      this.mcpDowntimeStart = now;
      return null;
    }

    // Check if downtime exceeds threshold
    const downtimeDuration = now - this.mcpDowntimeStart;
    if (downtimeDuration >= this.MCP_DOWNTIME_THRESHOLD_MS) {
      // Threshold exceeded — check if we should fire the nudge
      return this.checkTriggers(db, 'mcp_downtime');
    }

    return null;
  }

  /**
   * Reset MCP downtime tracking (call when connection is restored).
   */
  resetMcpDowntime(): void {
    this.mcpDowntimeStart = null;
  }
}
