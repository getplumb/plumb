import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrientationManager } from './orientation.js';

describe('OrientationManager', () => {
  let db: Database.Database;
  let tempDir: string;
  let orientationManager: OrientationManager;

  beforeEach(() => {
    // Create a temporary directory for the test database
    tempDir = mkdtempSync(join(tmpdir(), 'orientation-test-'));
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

    orientationManager = new OrientationManager();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('hasOrientationFired', () => {
    it('returns false on fresh database', () => {
      const result = orientationManager.hasOrientationFired(db);
      expect(result).toBe(false);
    });

    it('returns true after orientation has been recorded', () => {
      // Record the orientation
      orientationManager.recordOrientation(db);

      // Check should return true
      const result = orientationManager.hasOrientationFired(db);
      expect(result).toBe(true);
    });

    it('returns true when first_activation row exists in database', () => {
      // Manually insert a first_activation record
      db.prepare(`
        INSERT INTO nudge_log (id, trigger_type, fired_at)
        VALUES (?, ?, ?)
      `).run(crypto.randomUUID(), 'first_activation', new Date().toISOString());

      // Check should return true
      const result = orientationManager.hasOrientationFired(db);
      expect(result).toBe(true);
    });

    it('returns false when only other trigger types exist', () => {
      // Insert a different trigger type
      db.prepare(`
        INSERT INTO nudge_log (id, trigger_type, fired_at)
        VALUES (?, ?, ?)
      `).run(crypto.randomUUID(), 'second_integration', new Date().toISOString());

      // first_activation should still be false
      const result = orientationManager.hasOrientationFired(db);
      expect(result).toBe(false);
    });
  });

  describe('recordOrientation', () => {
    it('inserts a row into nudge_log with first_activation trigger type', () => {
      orientationManager.recordOrientation(db);

      const row = db.prepare<[string], { id: string; trigger_type: string }>(
        `SELECT id, trigger_type FROM nudge_log WHERE trigger_type = ?`
      ).get('first_activation');

      expect(row).toBeDefined();
      expect(row?.trigger_type).toBe('first_activation');
    });

    it('prevents duplicate orientation firing', () => {
      // Record orientation
      orientationManager.recordOrientation(db);

      // Verify it has fired
      expect(orientationManager.hasOrientationFired(db)).toBe(true);

      // Subsequent checks should return true (already fired)
      expect(orientationManager.hasOrientationFired(db)).toBe(true);
    });

    it('sets a valid timestamp', () => {
      const before = new Date().toISOString();
      orientationManager.recordOrientation(db);
      const after = new Date().toISOString();

      const row = db.prepare<[string], { fired_at: string }>(
        `SELECT fired_at FROM nudge_log WHERE trigger_type = ?`
      ).get('first_activation');

      expect(row).toBeDefined();
      expect(row!.fired_at).toBeTruthy();
      // Timestamp should be between before and after
      expect(row!.fired_at >= before).toBe(true);
      expect(row!.fired_at <= after).toBe(true);
    });
  });

  describe('getOrientationText', () => {
    it('contains required keywords and tool names', () => {
      const text = orientationManager.getOrientationText('/test/path/memory.db');

      expect(text).toContain('Plumb');
      expect(text).toContain('plumb_remember');
      expect(text).toContain('plumb_search');
      expect(text).toContain('AGENTS.md');
      expect(text).toContain('MEMORY.md');
    });

    it('includes the database path', () => {
      const dbPath = '/test/path/memory.db';
      const text = orientationManager.getOrientationText(dbPath);

      expect(text).toContain(dbPath);
    });

    it('expands ~ to home directory', () => {
      const dbPath = '~/.plumb/memory.db';
      const text = orientationManager.getOrientationText(dbPath);

      // Should not contain ~ in the output
      expect(text).not.toContain('~/.plumb');
      // Should contain the expanded path
      expect(text).toMatch(/\/.*\/.plumb\/memory\.db/);
    });

    it('wraps content in [PLUMB MEMORY] delimiters', () => {
      const text = orientationManager.getOrientationText('/test/path/memory.db');

      expect(text).toMatch(/^\[PLUMB MEMORY/);
      expect(text).toMatch(/\[\/PLUMB MEMORY\]$/);
    });

    it('includes "First activation" indicator', () => {
      const text = orientationManager.getOrientationText('/test/path/memory.db');

      expect(text).toContain('First activation');
    });
  });

  describe('integration', () => {
    it('orientation fires exactly once', () => {
      // First check - should not have fired
      expect(orientationManager.hasOrientationFired(db)).toBe(false);

      // Record orientation
      orientationManager.recordOrientation(db);

      // Second check - should have fired
      expect(orientationManager.hasOrientationFired(db)).toBe(true);

      // Third check - should still show as fired
      expect(orientationManager.hasOrientationFired(db)).toBe(true);
    });

    it('orientation persists across database connections', () => {
      const dbPath = join(tempDir, 'test.db');

      // Record with first manager instance
      orientationManager.recordOrientation(db);
      db.close();

      // Open new connection and create new manager
      const db2 = new Database(dbPath);
      const manager2 = new OrientationManager();

      // Should still show as fired
      expect(manager2.hasOrientationFired(db2)).toBe(true);

      db2.close();
    });
  });
});
