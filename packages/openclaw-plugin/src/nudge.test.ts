import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NudgeManager } from './nudge.js';

describe('NudgeManager', () => {
  let db: Database.Database;
  let tempDir: string;
  let nudgeManager: NudgeManager;

  beforeEach(() => {
    // Create a temporary directory for the test database
    tempDir = mkdtempSync(join(tmpdir(), 'nudge-test-'));
    const dbPath = join(tempDir, 'test.db');

    // Initialize database with nudge_log table
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS nudge_log (
        id TEXT PRIMARY KEY,
        trigger_type TEXT NOT NULL,
        fired_at TEXT NOT NULL
      )
    `);

    // Create raw_log table for integration trigger tests
    db.exec(`
      CREATE TABLE IF NOT EXISTS raw_log (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);

    nudgeManager = new NudgeManager();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('checkTriggers', () => {
    it('returns nudge text on first call for a trigger type', () => {
      const result = nudgeManager.checkTriggers(db, 'second_integration');
      expect(result).toBeTruthy();
      expect(result).toContain('getplumb.dev/upgrade');
      expect(result).toContain('multiple integrations');
    });

    it('returns null on second call for the same trigger type after recording', () => {
      // First call should return nudge text
      const firstResult = nudgeManager.checkTriggers(db, 'second_integration');
      expect(firstResult).toBeTruthy();

      // Record the nudge
      nudgeManager.recordNudge(db, 'second_integration');

      // Second call should return null
      const secondResult = nudgeManager.checkTriggers(db, 'second_integration');
      expect(secondResult).toBeNull();
    });

    it('returns null when trigger has already been recorded in database', () => {
      // Manually insert a nudge record
      db.prepare(`
        INSERT INTO nudge_log (id, trigger_type, fired_at)
        VALUES (?, ?, ?)
      `).run(crypto.randomUUID(), 'mcp_downtime', new Date().toISOString());

      // Check should return null
      const result = nudgeManager.checkTriggers(db, 'mcp_downtime');
      expect(result).toBeNull();
    });
  });

  describe('recordNudge', () => {
    it('inserts a row into nudge_log', () => {
      nudgeManager.recordNudge(db, 'second_integration');

      const row = db.prepare<[string], { id: string; trigger_type: string }>(
        `SELECT id, trigger_type FROM nudge_log WHERE trigger_type = ?`
      ).get('second_integration');

      expect(row).toBeDefined();
      expect(row?.trigger_type).toBe('second_integration');
    });

    it('prevents duplicate nudge firing after recording', () => {
      // Record a nudge
      nudgeManager.recordNudge(db, 'mcp_downtime');

      // Subsequent check should return null
      const result = nudgeManager.checkTriggers(db, 'mcp_downtime');
      expect(result).toBeNull();
    });
  });

  describe('getNudgeText', () => {
    it('returns appropriate text for second_integration trigger', () => {
      const text = nudgeManager.getNudgeText('second_integration');
      expect(text).toContain('multiple integrations');
      expect(text).toContain('getplumb.dev/upgrade');
    });

    it('returns appropriate text for mcp_downtime trigger', () => {
      const text = nudgeManager.getNudgeText('mcp_downtime');
      expect(text).toContain('unreachable');
      expect(text).toContain('getplumb.dev/upgrade');
    });
  });

  describe('trigger independence', () => {
    it('different trigger types fire independently', () => {
      // Fire second_integration trigger
      const integrationNudge = nudgeManager.checkTriggers(db, 'second_integration');
      expect(integrationNudge).toBeTruthy();
      nudgeManager.recordNudge(db, 'second_integration');

      // mcp_downtime trigger should still be able to fire
      const downtimeNudge = nudgeManager.checkTriggers(db, 'mcp_downtime');
      expect(downtimeNudge).toBeTruthy();
    });

    it('recording one trigger does not affect another', () => {
      nudgeManager.recordNudge(db, 'second_integration');

      // mcp_downtime should still fire
      const result = nudgeManager.checkTriggers(db, 'mcp_downtime');
      expect(result).toBeTruthy();
    });
  });

  describe('checkSecondIntegration', () => {
    it('returns null when only one session exists', () => {
      // Insert a single session
      db.prepare(`
        INSERT INTO raw_log (id, user_id, session_id, timestamp)
        VALUES (?, ?, ?, ?)
      `).run(crypto.randomUUID(), 'user-1', 'session-1', new Date().toISOString());

      const result = nudgeManager.checkSecondIntegration(db, 'user-1', 'session-1');
      expect(result).toBeNull();
    });

    it('returns nudge text when multiple sessions exist', () => {
      // Insert two different sessions
      db.prepare(`
        INSERT INTO raw_log (id, user_id, session_id, timestamp)
        VALUES (?, ?, ?, ?)
      `).run(crypto.randomUUID(), 'user-1', 'session-1', new Date().toISOString());

      db.prepare(`
        INSERT INTO raw_log (id, user_id, session_id, timestamp)
        VALUES (?, ?, ?, ?)
      `).run(crypto.randomUUID(), 'user-1', 'session-2', new Date().toISOString());

      const result = nudgeManager.checkSecondIntegration(db, 'user-1', 'session-1');
      expect(result).toBeTruthy();
      expect(result).toContain('multiple integrations');
    });

    it('only checks once per session', () => {
      // Insert multiple sessions
      db.prepare(`
        INSERT INTO raw_log (id, user_id, session_id, timestamp)
        VALUES (?, ?, ?, ?)
      `).run(crypto.randomUUID(), 'user-1', 'session-1', new Date().toISOString());

      db.prepare(`
        INSERT INTO raw_log (id, user_id, session_id, timestamp)
        VALUES (?, ?, ?, ?)
      `).run(crypto.randomUUID(), 'user-1', 'session-2', new Date().toISOString());

      // First call for session-1
      const firstResult = nudgeManager.checkSecondIntegration(db, 'user-1', 'session-1');
      expect(firstResult).toBeTruthy();

      // Record the nudge
      nudgeManager.recordNudge(db, 'second_integration');

      // Second call for the same session should return null (already seen)
      const secondResult = nudgeManager.checkSecondIntegration(db, 'user-1', 'session-1');
      expect(secondResult).toBeNull();
    });

    it('returns null after trigger has been recorded', () => {
      // Insert multiple sessions
      db.prepare(`
        INSERT INTO raw_log (id, user_id, session_id, timestamp)
        VALUES (?, ?, ?, ?)
      `).run(crypto.randomUUID(), 'user-1', 'session-1', new Date().toISOString());

      db.prepare(`
        INSERT INTO raw_log (id, user_id, session_id, timestamp)
        VALUES (?, ?, ?, ?)
      `).run(crypto.randomUUID(), 'user-1', 'session-2', new Date().toISOString());

      // Record the nudge first
      nudgeManager.recordNudge(db, 'second_integration');

      // Check should return null
      const result = nudgeManager.checkSecondIntegration(db, 'user-1', 'session-3');
      expect(result).toBeNull();
    });
  });

  describe('triggerMcpDowntime', () => {
    it('returns null on first call (downtime just started)', () => {
      const result = nudgeManager.triggerMcpDowntime(db);
      expect(result).toBeNull();
    });

    it('returns null when downtime is less than 5 minutes', async () => {
      // First call to start tracking
      nudgeManager.triggerMcpDowntime(db);

      // Immediately call again (downtime < 5 minutes)
      const result = nudgeManager.triggerMcpDowntime(db);
      expect(result).toBeNull();
    });

    it('returns nudge text when downtime exceeds 5 minutes', () => {
      // Simulate downtime exceeding threshold by manipulating the internal state
      // Note: This is a simple test; in production, you'd wait or mock time
      const manager = nudgeManager as any;
      manager.mcpDowntimeStart = Date.now() - (6 * 60 * 1000); // 6 minutes ago

      const result = nudgeManager.triggerMcpDowntime(db);
      expect(result).toBeTruthy();
      expect(result).toContain('unreachable');
    });

    it('resets downtime tracking when resetMcpDowntime is called', () => {
      // Start downtime
      nudgeManager.triggerMcpDowntime(db);

      // Reset
      nudgeManager.resetMcpDowntime();

      // Check internal state is cleared
      const manager = nudgeManager as any;
      expect(manager.mcpDowntimeStart).toBeNull();
    });

    it('returns null after trigger has been recorded', () => {
      // Record the downtime nudge
      nudgeManager.recordNudge(db, 'mcp_downtime');

      // Simulate long downtime
      const manager = nudgeManager as any;
      manager.mcpDowntimeStart = Date.now() - (6 * 60 * 1000);

      const result = nudgeManager.triggerMcpDowntime(db);
      expect(result).toBeNull();
    });
  });
});
