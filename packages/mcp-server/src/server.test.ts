import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LocalStore, StoreStatus, MemoryFactSearchResult, WikiSearchOptions, WikiSearchResult } from '@getplumb/core';
import { WikiStore, hashContent, serializeEmbedding } from '@getplumb/core';
import { createClaudeWikiServer, createPlumbServer } from './server.js';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WikiToolsConfig, WikiToolsDeps } from './tools/wiki.js';

// Minimal mock of LocalStore — only the methods used by MCP tools.
function makeMockStore(): LocalStore {
  const memoryFactResult: MemoryFactSearchResult = {
    fact_id: 'fact-001',
    content: 'User asked about coffee preferences',
    source_session_id: 'sess-001',
    source_session_label: 'My Session',
    created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    tags: null,
    confidence: 0.95,
    final_score: 0.85,
  };

  const status: StoreStatus = {
    factCount: 5,
    lastIngestion: new Date('2026-01-15T00:00:00Z'),
    storageBytes: 102400,
  };

  return {
    searchMemoryFacts: vi.fn().mockResolvedValue([memoryFactResult]),
    status: vi.fn().mockResolvedValue(status),
    ingestMemoryFact: vi.fn().mockResolvedValue({ factId: 'f1' }),
    delete: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  } as unknown as LocalStore;
}

type McpTextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/**
 * Invoke a registered tool through the MCP server's internal handler.
 */
async function callTool(
  store: LocalStore,
  toolName: string,
  args: Record<string, unknown>,
  wikiConfig?: WikiToolsConfig,
  wikiDeps?: WikiToolsDeps,
): Promise<McpTextResult> {
  const mcpServer = wikiConfig ? createPlumbServer(store, wikiConfig, wikiDeps) : createPlumbServer(store);
  const rawServer = mcpServer.server;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (rawServer as any)._requestHandlers
    .get('tools/call')
    ?.({ method: 'tools/call', params: { name: toolName, arguments: args } }, {});

  return result as McpTextResult;
}

async function listTools(store: LocalStore, wikiConfig: WikiToolsConfig): Promise<string[]> {
  const mcpServer = createPlumbServer(store, wikiConfig);
  const rawServer = mcpServer.server;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (rawServer as any)._requestHandlers
    .get('tools/list')
    ?.({ method: 'tools/list', params: {} }, {});
  return (result.tools as Array<{ name: string }>).map((tool) => tool.name);
}

async function listClaudeWikiTools(wikiConfig: WikiToolsConfig): Promise<string[]> {
  const mcpServer = createClaudeWikiServer(wikiConfig);
  const rawServer = mcpServer.server;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (rawServer as any)._requestHandlers
    .get('tools/list')
    ?.({ method: 'tools/list', params: {} }, {});
  return (result.tools as Array<{ name: string }>).map((tool) => tool.name);
}

async function writePage(wikiRoot: string, relPath: string, body: string): Promise<string> {
  const raw = `---\ntype: project\ncreated: '2026-01-01'\nupdated: '2026-01-02'\nconfidence: high\ntags: [test]\nsource_refs: []\n---\n${body}\n`;
  const abs = join(wikiRoot, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, raw, 'utf8');
  return raw;
}

function fakeSearchResult(title: string, path = `${title.toLowerCase()}.md`): WikiSearchResult {
  return {
    path,
    title,
    type: 'project',
    snippet: `${title} snippet`,
    section: '',
    chunkIndex: 0,
    score: 1,
    childScore: 1,
    parentSectionScore: 1,
    supportingChunkCount: 1,
  };
}

async function seedWikiDb(dbPath: string, wikiRoot: string): Promise<void> {
  const raw = await writePage(wikiRoot, 'projects/plumb-v2.md', '# Plumb V2\n\nClaude MCP adapter wiki search content.');
  await writePage(wikiRoot, 'people/clay.md', '# Clay\n\nLinks to [[Plumb V2]].');

  const store = await WikiStore.create({ dbPath });
  const db = store.db;

  for (const row of [
    ['projects/plumb-v2', 'projects/plumb-v2.md', 'project', 'Plumb V2', hashContent(raw)],
    ['people/clay', 'people/clay.md', 'person', 'Clay', hashContent(await readFile(join(wikiRoot, 'people/clay.md'), 'utf8'))],
  ]) {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO wiki_pages
         (id, path, type, title, created, updated, confidence, tags, source_refs, status, word_count, content_hash)
       VALUES (?, ?, ?, ?, '', '', 'high', '[]', '[]', 'active', 10, ?)`,
    );
    stmt.bind(row);
    stmt.step();
    stmt.finalize();
  }

  const chunkStmt = db.prepare(
    `INSERT OR REPLACE INTO wiki_chunks
       (page_id, chunk_index, content, section, embed_status, embed_model, embedding)
     VALUES (?, 0, ?, '', 'done', 'test-model', ?)`,
  );
  chunkStmt.bind([
    'projects/plumb-v2',
    'Claude MCP adapter wiki search content for Plumb V2.',
    serializeEmbedding(new Float32Array(384).fill(0)),
  ]);
  chunkStmt.step();
  chunkStmt.finalize();

  for (const row of [
    ['people/clay', 'Plumb V2', 'projects/plumb-v2', 1],
    ['projects/plumb-v2', 'Clay', 'people/clay', 1],
  ]) {
    const stmt = db.prepare(
      `INSERT INTO wiki_links (source_page_id, target_title, target_page_id, resolved)
       VALUES (?, ?, ?, ?)`,
    );
    stmt.bind(row);
    stmt.step();
    stmt.finalize();
  }

  store.close();
}

describe('MCP server tool schemas and responses', () => {
  let store: LocalStore;
  let tempRoot: string;
  let wikiRoot: string;
  let wikiConfig: WikiToolsConfig;

  beforeEach(async () => {
    store = makeMockStore();
    tempRoot = await mkdtemp(join(tmpdir(), 'plumb-mcp-test-'));
    wikiRoot = join(tempRoot, 'wiki');
    await mkdir(wikiRoot, { recursive: true });
    wikiConfig = {
      wikiRoot,
      wikiDbPath: join(tempRoot, 'wiki.db'),
      wikiQueuePath: join(tempRoot, 'wiki-queue.jsonl'),
    };
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('registers memory tools and all five wiki tools', async () => {
    const tools = await listTools(store, wikiConfig);
    expect([...tools].sort()).toEqual([
      'memory_search',
      'memory_status',
      'plumb_wiki_links',
      'plumb_wiki_list',
      'plumb_wiki_queue_edit',
      'plumb_wiki_read',
      'plumb_wiki_search',
    ]);
  });

  it('registers exactly the four Claude wiki tools on the Claude-specific server', async () => {
    const tools = await listClaudeWikiTools(wikiConfig);
    expect([...tools].sort()).toEqual([
      'plumb_wiki_list',
      'plumb_wiki_queue_edit',
      'plumb_wiki_read',
      'plumb_wiki_search',
    ]);
  });

  describe('memory_search', () => {
    it('returns array of results from memory facts', async () => {
      const result = await callTool(store, 'memory_search', {
        query: 'coffee',
      });

      expect(store.searchMemoryFacts).toHaveBeenCalledWith('coffee', 20);
      const parsed = JSON.parse(result.content[0]!.text) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    });

    it('uses custom limit', async () => {
      await callTool(store, 'memory_search', { query: 'test', limit: 5 });
      expect(store.searchMemoryFacts).toHaveBeenCalledWith('test', 5);
    });

    it('result items have required shape', async () => {
      const result = await callTool(store, 'memory_search', {
        query: 'coffee',
      });

      const parsed = JSON.parse(result.content[0]!.text) as Array<{
        content: string;
        score: number;
        age_in_days: number;
        session_label: string;
      }>;

      const first = parsed[0];
      expect(first).toBeDefined();
      if (first) {
        expect(typeof first.content).toBe('string');
        expect(typeof first.score).toBe('number');
        expect(typeof first.age_in_days).toBe('number');
        expect(typeof first.session_label).toBe('string');
      }
    });
  });

  describe('memory_status', () => {
    it('returns StoreStatus fields', async () => {
      const result = await callTool(store, 'memory_status', {}) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(store.status).toHaveBeenCalledOnce();
      const parsed = JSON.parse(result.content[0]!.text) as {
        factCount: number;
        lastIngestion: string | null;
        storageBytes: number;
      };

      expect(parsed.factCount).toBe(5);
      expect(parsed.lastIngestion).toBe('2026-01-15T00:00:00.000Z');
      expect(parsed.storageBytes).toBe(102400);
    });
  });

  describe('wiki tools', () => {
    it('reads pages and auto-appends .md', async () => {
      await writePage(wikiRoot, 'people/alice.md', '# Alice\n\nAlice likes tea.');

      const result = await callTool(store, 'plumb_wiki_read', { path: 'people/alice' }, wikiConfig);

      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain('**Path:** people/alice.md');
      expect(result.content[0]!.text).toContain('Alice likes tea.');
    });

    it('lists immediate children and excludes metadata files', async () => {
      await writePage(wikiRoot, 'root-page.md', '# Root Page\n');
      await writePage(wikiRoot, 'SCHEMA.md', '# Schema\n');
      await writePage(wikiRoot, 'AUDIT_test.md', '# Audit\n');
      await writePage(wikiRoot, 'people/alice.md', '# Alice\n');
      await mkdir(join(wikiRoot, 'archive'), { recursive: true });

      const rootResult = await callTool(store, 'plumb_wiki_list', {}, wikiConfig);
      const peopleResult = await callTool(store, 'plumb_wiki_list', { directory: 'people' }, wikiConfig);

      expect(rootResult.isError).toBeUndefined();
      expect(rootResult.content[0]!.text).toContain('people/');
      expect(rootResult.content[0]!.text).toContain('root-page.md');
      expect(rootResult.content[0]!.text).not.toContain('SCHEMA.md');
      expect(rootResult.content[0]!.text).not.toContain('AUDIT_test.md');
      expect(rootResult.content[0]!.text).not.toContain('archive/');
      expect(rootResult.content[0]!.text).not.toContain('people/alice.md');
      expect(peopleResult.content[0]!.text).toContain('people/alice.md');
    });

    it('queues trimmed wiki edits and returns the queued id without starting a worker', async () => {
      const result = await callTool(
        store,
        'plumb_wiki_queue_edit',
        { fact: '  Alice started using the Plumb V2 MCP adapter.  \n' },
        wikiConfig,
      );

      expect(result.isError).toBeUndefined();
      const id = result.content[0]!.text;
      expect(id).toBeTruthy();
      const queueText = await readFile(wikiConfig.wikiQueuePath, 'utf8');
      const queued = JSON.parse(queueText.trim()) as { id: string; fact: string; status: string };
      expect(queued.id).toBe(id);
      expect(queued.fact).toBe('Alice started using the Plumb V2 MCP adapter.');
      expect(queued.status).toBe('pending');
    });

    it('rejects blank wiki edits', async () => {
      const result = await callTool(store, 'plumb_wiki_queue_edit', { fact: ' \n\t ' }, wikiConfig);

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('fact must not be blank');
    });

    it('accepts a 10,000-character trimmed wiki edit', async () => {
      const fact = `${'a'.repeat(10_000)}\n`;
      const result = await callTool(store, 'plumb_wiki_queue_edit', { fact }, wikiConfig);

      expect(result.isError).toBeUndefined();
      const queueText = await readFile(wikiConfig.wikiQueuePath, 'utf8');
      const queued = JSON.parse(queueText.trim()) as { fact: string };
      expect(queued.fact).toHaveLength(10_000);
    });

    it('rejects wiki edits longer than 10,000 characters after trimming', async () => {
      const result = await callTool(store, 'plumb_wiki_queue_edit', { fact: 'a'.repeat(10_001) }, wikiConfig);

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('10,000 characters or fewer');
    });

    it('rejects traversal, absolute paths, null bytes, and symlink escapes for read/list', async () => {
      const outside = join(tempRoot, 'outside');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'secret.md'), '# Secret\n', 'utf8');
      await symlink(join(outside, 'secret.md'), join(wikiRoot, 'escape.md'));
      await symlink(outside, join(wikiRoot, 'escape-dir'));

      const readTraversal = await callTool(store, 'plumb_wiki_read', { path: '../outside/secret.md' }, wikiConfig);
      const readAbsolute = await callTool(store, 'plumb_wiki_read', { path: join(outside, 'secret.md') }, wikiConfig);
      const readNull = await callTool(store, 'plumb_wiki_read', { path: 'bad\0path.md' }, wikiConfig);
      const readSymlink = await callTool(store, 'plumb_wiki_read', { path: 'escape.md' }, wikiConfig);
      const listTraversal = await callTool(store, 'plumb_wiki_list', { directory: '..' }, wikiConfig);
      const listSymlink = await callTool(store, 'plumb_wiki_list', { directory: 'escape-dir' }, wikiConfig);
      const rootList = await callTool(store, 'plumb_wiki_list', {}, wikiConfig);

      for (const result of [readTraversal, readAbsolute, readNull, readSymlink, listTraversal, listSymlink]) {
        expect(result.isError).toBe(true);
      }
      expect(rootList.content[0]!.text).not.toContain('escape.md');
      expect(rootList.content[0]!.text).not.toContain('escape-dir/');
    });

    it('returns inbound and outbound links from wiki.db', async () => {
      await seedWikiDb(wikiConfig.wikiDbPath, wikiRoot);

      const result = await callTool(store, 'plumb_wiki_links', { path: 'projects/plumb-v2' }, wikiConfig);

      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain('Wiki links for "projects/plumb-v2.md"');
      expect(result.content[0]!.text).toContain('[[Clay]] → people/clay');
      expect(result.content[0]!.text).toContain('← people/clay via [[Plumb V2]]');
    });

    it('searches wiki.db', async () => {
      await seedWikiDb(wikiConfig.wikiDbPath, wikiRoot);

      const result = await callTool(
        store,
        'plumb_wiki_search',
        { query: 'Claude MCP adapter', topK: 5 },
        wikiConfig,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain('Wiki search results for "Claude MCP adapter"');
      expect(result.content[0]!.text).toContain('**Plumb V2** (projects/plumb-v2.md) [project]');
    });

    it('clamps search topK above the maximum to 10', async () => {
      const search = vi.fn().mockResolvedValue([fakeSearchResult('Result')]);
      const close = vi.fn();
      const createWikiSearch = vi.fn().mockResolvedValue({ search, close });

      const result = await callTool(
        store,
        'plumb_wiki_search',
        { query: 'clamp high', topK: 99 },
        wikiConfig,
        { createWikiSearch },
      );

      expect(result.isError).toBeUndefined();
      expect(search).toHaveBeenCalledWith('clamp high', 10);
      expect(close).toHaveBeenCalledOnce();
    });

    it('clamps search topK below the minimum to 1', async () => {
      const search = vi.fn().mockResolvedValue([fakeSearchResult('Result')]);
      const createWikiSearch = vi.fn().mockResolvedValue({ search, close: vi.fn() });

      await callTool(
        store,
        'plumb_wiki_search',
        { query: 'clamp low', topK: 0 },
        wikiConfig,
        { createWikiSearch },
      );

      expect(search).toHaveBeenCalledWith('clamp low', 1);
    });

    it('creates wiki search with preCheck false so MCP search cannot trigger re-embedding', async () => {
      let capturedOptions: WikiSearchOptions | undefined;
      const createWikiSearch = vi.fn(async (options: WikiSearchOptions) => {
        capturedOptions = options;
        return { search: vi.fn().mockResolvedValue([]), close: vi.fn() };
      });

      await callTool(
        store,
        'plumb_wiki_search',
        { query: 'read only' },
        wikiConfig,
        { createWikiSearch },
      );

      expect(capturedOptions).toMatchObject({
        wikiRoot: wikiConfig.wikiRoot,
        dbPath: wikiConfig.wikiDbPath,
        preCheck: false,
      });
    });

    it('requests active contextual retrieval matching the production plugin config', async () => {
      let capturedOptions: WikiSearchOptions | undefined;
      const createWikiSearch = vi.fn(async (options: WikiSearchOptions) => {
        capturedOptions = options;
        return { search: vi.fn().mockResolvedValue([]), close: vi.fn() };
      });

      await callTool(store, 'plumb_wiki_search', { query: 'contextual config' }, wikiConfig, { createWikiSearch });

      expect(capturedOptions?.contextualRetrieval).toMatchObject({
        mode: 'active',
        parentTokenBudgets: [400, 300, 125, 100, 75],
        maxParentTokens: 1000,
      });
    });

    it('window-caps a long contextual parent section around the matched child instead of a flat 200-char cut', async () => {
      const longSection = `${'padding text '.repeat(200)}NEEDLE the matched child sentence.${'more padding '.repeat(200)}`;
      const result: WikiSearchResult = {
        ...fakeSearchResult('Long Section'),
        retrievalSource: 'contextual',
        matchedChildSnippet: 'NEEDLE the matched child sentence.',
        parentContext: longSection,
        sourceChunkId: 1,
      };
      const createWikiSearch = vi.fn().mockResolvedValue({ search: vi.fn().mockResolvedValue([result]), close: vi.fn() });

      const res = await callTool(store, 'plumb_wiki_search', { query: 'needle' }, wikiConfig, { createWikiSearch });

      expect(res.content[0]!.text).toContain('NEEDLE the matched child sentence.');
      expect(res.content[0]!.text.length).toBeLessThan(longSection.length);
    });

    it('appends E039 same-page sibling chunks for contextual results when budget allows', async () => {
      const result: WikiSearchResult = {
        ...fakeSearchResult('Multi Section'),
        retrievalSource: 'contextual',
        matchedChildSnippet: 'short child',
        parentContext: 'short child',
        sourceChunkId: 1,
        siblingCandidates: [
          { chunkIndex: 5, section: 'Details', content: 'a low scoring sibling chunk', score: 0.1 },
          { chunkIndex: 9, section: 'History', content: 'a high scoring sibling chunk', score: 0.9 },
        ],
      };
      const createWikiSearch = vi.fn().mockResolvedValue({ search: vi.fn().mockResolvedValue([result]), close: vi.fn() });

      const res = await callTool(store, 'plumb_wiki_search', { query: 'anything' }, wikiConfig, { createWikiSearch });

      expect(res.content[0]!.text).toContain('a high scoring sibling chunk');
      expect(res.content[0]!.text).toContain('[same-page chunk 9 | History]');
    });

    it('leaves non-contextual (plain fallback) results on the existing 200-char truncation', async () => {
      const longPlain = 'x'.repeat(500);
      const result: WikiSearchResult = { ...fakeSearchResult('Plain Result'), snippet: longPlain };
      const createWikiSearch = vi.fn().mockResolvedValue({ search: vi.fn().mockResolvedValue([result]), close: vi.fn() });

      const res = await callTool(store, 'plumb_wiki_search', { query: 'plain' }, wikiConfig, { createWikiSearch });

      const snippetLine = res.content[0]!.text.split('\n').find((l) => l.startsWith('   x'));
      expect(snippetLine?.trim().length).toBe(200);
    });
  });
});
