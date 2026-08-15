import { describe, it, expect } from 'vitest';
import { resolveConfig } from './config.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

describe('resolveConfig', () => {
  it('returns defaults when no args or env vars are set', () => {
    const config = resolveConfig([], {});
    expect(config.userId).toBe('default');
    expect(config.dbPath).toBe(join(homedir(), '.plumb', 'memory.db'));
    expect(config.wikiRoot).toBe(join(homedir(), '.plumb', 'wiki'));
    expect(config.wikiDbPath).toBe(join(homedir(), '.plumb', 'wiki.db'));
    expect(config.wikiQueuePath).toBe(join(homedir(), '.plumb', 'wiki-queue.jsonl'));
  });

  it('reads from environment variables', () => {
    const config = resolveConfig([], {
      PLUMB_USER_ID: 'alice',
      PLUMB_DB_PATH: '/tmp/test.db',
      PLUMB_WIKI_ROOT: '/tmp/wiki',
      PLUMB_WIKI_DB_PATH: '/tmp/wiki.db',
      PLUMB_WIKI_QUEUE_PATH: '/tmp/wiki-queue.jsonl',
    });
    expect(config.userId).toBe('alice');
    expect(config.dbPath).toBe('/tmp/test.db');
    expect(config.wikiRoot).toBe('/tmp/wiki');
    expect(config.wikiDbPath).toBe('/tmp/wiki.db');
    expect(config.wikiQueuePath).toBe('/tmp/wiki-queue.jsonl');
  });

  it('reads from CLI flags', () => {
    const config = resolveConfig(
      [
        '--user-id',
        'bob',
        '--db',
        '/var/plumb.db',
        '--wiki-root',
        '/var/wiki',
        '--wiki-db',
        '/var/wiki.db',
        '--wiki-queue',
        '/var/wiki-queue.jsonl',
      ],
      {},
    );
    expect(config.userId).toBe('bob');
    expect(config.dbPath).toBe('/var/plumb.db');
    expect(config.wikiRoot).toBe('/var/wiki');
    expect(config.wikiDbPath).toBe('/var/wiki.db');
    expect(config.wikiQueuePath).toBe('/var/wiki-queue.jsonl');
  });

  it('CLI flags override environment variables', () => {
    const config = resolveConfig(
      [
        '--user-id',
        'charlie',
        '--db',
        '/opt/plumb.db',
        '--wiki-root',
        '/opt/wiki',
        '--wiki-db',
        '/opt/wiki.db',
        '--wiki-queue',
        '/opt/wiki-queue.jsonl',
      ],
      {
        PLUMB_USER_ID: 'alice',
        PLUMB_DB_PATH: '/tmp/test.db',
        PLUMB_WIKI_ROOT: '/tmp/wiki',
        PLUMB_WIKI_DB_PATH: '/tmp/wiki.db',
        PLUMB_WIKI_QUEUE_PATH: '/tmp/wiki-queue.jsonl',
      },
    );
    expect(config.userId).toBe('charlie');
    expect(config.dbPath).toBe('/opt/plumb.db');
    expect(config.wikiRoot).toBe('/opt/wiki');
    expect(config.wikiDbPath).toBe('/opt/wiki.db');
    expect(config.wikiQueuePath).toBe('/opt/wiki-queue.jsonl');
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

  it('expands tilde in wiki paths', () => {
    const config = resolveConfig(
      ['--wiki-root', '~/wiki-root', '--wiki-db', '~/data/wiki.db', '--wiki-queue', '~/queues/wiki.jsonl'],
      {},
    );
    expect(config.wikiRoot).toBe(join(homedir(), 'wiki-root'));
    expect(config.wikiDbPath).toBe(join(homedir(), 'data', 'wiki.db'));
    expect(config.wikiQueuePath).toBe(join(homedir(), 'queues', 'wiki.jsonl'));
  });

  it('handles tilde-only path', () => {
    const config = resolveConfig(['--db', '~', '--wiki-root', '~', '--wiki-db', '~', '--wiki-queue', '~'], {});
    expect(config.dbPath).toBe(homedir());
    expect(config.wikiRoot).toBe(homedir());
    expect(config.wikiDbPath).toBe(homedir());
    expect(config.wikiQueuePath).toBe(homedir());
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
