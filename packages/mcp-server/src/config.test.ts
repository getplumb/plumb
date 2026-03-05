import { describe, it, expect } from 'vitest';
import { resolveConfig } from './config.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

describe('resolveConfig', () => {
  it('returns defaults when no args or env vars are set', () => {
    const config = resolveConfig([], {});
    expect(config.userId).toBe('default');
    expect(config.dbPath).toBe(join(homedir(), '.plumb', 'memory.db'));
  });

  it('reads from environment variables', () => {
    const config = resolveConfig([], {
      PLUMB_USER_ID: 'alice',
      PLUMB_DB_PATH: '/tmp/test.db',
    });
    expect(config.userId).toBe('alice');
    expect(config.dbPath).toBe('/tmp/test.db');
  });

  it('reads from CLI flags', () => {
    const config = resolveConfig(['--user-id', 'bob', '--db', '/var/plumb.db'], {});
    expect(config.userId).toBe('bob');
    expect(config.dbPath).toBe('/var/plumb.db');
  });

  it('CLI flags override environment variables', () => {
    const config = resolveConfig(
      ['--user-id', 'charlie', '--db', '/opt/plumb.db'],
      {
        PLUMB_USER_ID: 'alice',
        PLUMB_DB_PATH: '/tmp/test.db',
      }
    );
    expect(config.userId).toBe('charlie');
    expect(config.dbPath).toBe('/opt/plumb.db');
  });

  it('expands tilde in dbPath from environment', () => {
    const config = resolveConfig([], {
      PLUMB_DB_PATH: '~/custom/memory.db',
    });
    expect(config.dbPath).toBe(join(homedir(), 'custom', 'memory.db'));
  });

  it('expands tilde in dbPath from CLI flag', () => {
    const config = resolveConfig(['--db', '~/data/plumb.db'], {});
    expect(config.dbPath).toBe(join(homedir(), 'data', 'plumb.db'));
  });

  it('handles tilde-only path', () => {
    const config = resolveConfig(['--db', '~'], {});
    expect(config.dbPath).toBe(homedir());
  });

  it('handles partial flags without values', () => {
    const config = resolveConfig(['--user-id'], {});
    expect(config.userId).toBe('default');
  });

  it('handles mixed flags and other arguments', () => {
    const config = resolveConfig(['--user-id', 'dave', 'other-arg', '--db', '/tmp/db'], {});
    expect(config.userId).toBe('dave');
    expect(config.dbPath).toBe('/tmp/db');
  });
});
