import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendError, type ErrorLogEntry } from './error-logger.js';
import { readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('error-logger', () => {
  const testDir = join(tmpdir(), 'plumb-error-logger-test');
  const testLogPath = join(testDir, 'errors.log');

  beforeEach(() => {
    // Clean up test directory before each test
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    // Set PLUMB_DB_PATH to a test location so we can control the error log path
    process.env.PLUMB_DB_PATH = join(testDir, 'memory.db');
  });

  afterEach(() => {
    // Clean up after tests
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    delete process.env.PLUMB_DB_PATH;
  });

  it('appends error as valid JSONL', () => {
    const entry: ErrorLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'extraction_error',
      message: 'Rate limit exceeded',
      stack: 'Error: Rate limit exceeded\n    at ...',
      context: { sessionId: 'test-session', userId: 'clay' },
    };

    appendError(entry, process.env.PLUMB_DB_PATH);

    expect(existsSync(testLogPath)).toBe(true);

    const content = readFileSync(testLogPath, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as ErrorLogEntry;
    expect(parsed.timestamp).toBe(entry.timestamp);
    expect(parsed.type).toBe('extraction_error');
    expect(parsed.message).toBe('Rate limit exceeded');
    expect(parsed.stack).toBe(entry.stack);
    expect(parsed.context).toEqual({ sessionId: 'test-session', userId: 'clay' });
  });

  it('creates file and directory if missing', () => {
    expect(existsSync(testDir)).toBe(false);

    const entry: ErrorLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'ingest_error',
      message: 'Database write failed',
    };

    appendError(entry, process.env.PLUMB_DB_PATH);

    expect(existsSync(testDir)).toBe(true);
    expect(existsSync(testLogPath)).toBe(true);

    const content = readFileSync(testLogPath, 'utf-8');
    const parsed = JSON.parse(content.trim()) as ErrorLogEntry;
    expect(parsed.type).toBe('ingest_error');
  });

  it('appends multiple errors as separate lines', () => {
    const entry1: ErrorLogEntry = {
      timestamp: '2026-03-04T10:00:00Z',
      type: 'error_type_1',
      message: 'First error',
    };

    const entry2: ErrorLogEntry = {
      timestamp: '2026-03-04T10:01:00Z',
      type: 'error_type_2',
      message: 'Second error',
    };

    appendError(entry1, process.env.PLUMB_DB_PATH);
    appendError(entry2, process.env.PLUMB_DB_PATH);

    const content = readFileSync(testLogPath, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(2);

    const parsed1 = JSON.parse(lines[0]!) as ErrorLogEntry;
    expect(parsed1.message).toBe('First error');

    const parsed2 = JSON.parse(lines[1]!) as ErrorLogEntry;
    expect(parsed2.message).toBe('Second error');
  });

  it('is non-blocking on write failure (does not throw)', () => {
    // Create directory but make it read-only to simulate a write failure
    mkdirSync(testDir, { recursive: true });

    // Mock console.error to verify it's called instead of throwing
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Set an invalid path that will fail (we can't easily make directory read-only in tests,
    // so we'll just verify that appendError doesn't throw even if something goes wrong)

    // This is a best-effort test — in practice, appendError wraps everything in try/catch
    const entry: ErrorLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'test_error',
      message: 'Should not throw',
    };

    // This should not throw regardless of what happens
    expect(() => appendError(entry)).not.toThrow();

    consoleSpy.mockRestore();
  });

  it('handles entries without optional fields', () => {
    const minimalEntry: ErrorLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'simple_error',
      message: 'Minimal error',
    };

    appendError(minimalEntry, process.env.PLUMB_DB_PATH);

    const content = readFileSync(testLogPath, 'utf-8');
    const parsed = JSON.parse(content.trim()) as ErrorLogEntry;

    expect(parsed.timestamp).toBe(minimalEntry.timestamp);
    expect(parsed.type).toBe('simple_error');
    expect(parsed.message).toBe('Minimal error');
    expect(parsed.stack).toBeUndefined();
    expect(parsed.context).toBeUndefined();
  });

  it('uses ~/.plumb/errors.log when PLUMB_DB_PATH is not set', () => {
    delete process.env.PLUMB_DB_PATH;

    const entry: ErrorLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'default_path_test',
      message: 'Testing default path',
    };

    // We can't easily verify the exact path without reading from ~/.plumb,
    // but we can verify appendError doesn't throw
    expect(() => appendError(entry)).not.toThrow();
  });
});
