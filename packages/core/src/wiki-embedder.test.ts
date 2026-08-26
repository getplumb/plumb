import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkByH2, chunkText, runWikiEmbed } from './wiki-embedder.js';
import { WikiStore } from './wiki-schema.js';
import { DEFAULT_CONTEXTUAL_MODEL } from './wiki-contextual-embeddings.js';

function tempWiki(): { root: string; dbPath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'wiki-embedder-test-'));
  return { root, dbPath: join(root, 'wiki.db'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('wiki chunking', () => {
  it('enforces strict max chunk bounds with deterministic fallback splitting', () => {
    const oversized = `## Oversized\n\n${'alpha '.repeat(120)}${'bravo'.repeat(80)}\n\nTail sentence.`;
    const chunks = chunkByH2(oversized, 160);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 160)).toBe(true);
    expect(chunks.map((chunk) => chunk.content).join('\n\n')).toContain('## Oversized');
    expect(chunks.map((chunk) => chunk.content).join('\n\n')).toContain('Tail sentence.');
  });

  it('merges tiny low-information heading chunks into neighbors while preserving source spans', () => {
    const body = '## A\n\n## Durable Detail\n\nThis paragraph has enough substance to stand as the neighboring evidence span.';
    const chunks = chunkByH2(body, 240);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('## A');
    expect(chunks[0]!.content).toContain('## Durable Detail');
    expect(chunks[0]!.charStart).toBe(0);
    expect(chunks[0]!.charEnd).toBe(body.length);
  });

  it('keeps legacy chunkText bounded even for single giant paragraphs', () => {
    const chunks = chunkText('x'.repeat(401), 100);
    expect(chunks).toHaveLength(5);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
  });

  it('rolls back page upsert and chunk replacement atomically when chunk insert fails', async () => {
    const wiki = tempWiki();
    try {
      mkdirSync(join(wiki.root, 'people'), { recursive: true });
      const path = join(wiki.root, 'people', 'alice.md');
      writeFileSync(path, '---\ntype: person\n---\n# Alice\n\nOriginal body for rollback.', 'utf8');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      const store = await WikiStore.create({ dbPath: wiki.dbPath });
      const originalHash = store.db.selectValue("SELECT content_hash FROM wiki_pages WHERE id = 'people/alice'");
      const originalChunks = store.db.selectValue("SELECT COUNT(*) FROM wiki_chunks WHERE page_id = 'people/alice'");
      store.db.exec("CREATE TRIGGER fail_wiki_chunk_insert BEFORE INSERT ON wiki_chunks BEGIN SELECT RAISE(FAIL, 'forced insert failure'); END");
      store.close();

      writeFileSync(path, '---\ntype: person\n---\n# Alice\n\nChanged body should not commit.', 'utf8');
      const stats = await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath });
      expect(stats.errors).toBe(1);

      const verify = await WikiStore.create({ dbPath: wiki.dbPath });
      try {
        expect(verify.db.selectValue("SELECT content_hash FROM wiki_pages WHERE id = 'people/alice'")).toBe(originalHash);
        expect(verify.db.selectValue("SELECT COUNT(*) FROM wiki_chunks WHERE page_id = 'people/alice'")).toBe(originalChunks);
      } finally {
        verify.close();
      }
    } finally {
      wiki.cleanup();
    }
  });

  it('refreshes contextual rows for changed pages when a sidecar was already provisioned', async () => {
    const wiki = tempWiki();
    try {
      mkdirSync(join(wiki.root, 'people'), { recursive: true });
      const path = join(wiki.root, 'people', 'alice.md');
      writeFileSync(path, '---\ntype: person\n---\n# Alice\n\nOriginal body.', 'utf8');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath, contextualRefresh: true });

      const first = await WikiStore.create({ dbPath: wiki.dbPath });
      const firstContextCount = first.db.selectValue("SELECT COUNT(*) FROM wiki_chunk_context_embeddings WHERE page_id = 'people/alice' AND model = '" + DEFAULT_CONTEXTUAL_MODEL + "' AND status = 'done'") as number;
      expect(firstContextCount).toBeGreaterThan(0);
      first.close();

      writeFileSync(path, '---\ntype: person\n---\n# Alice\n\nChanged body with enough content to force a refreshed chunk.', 'utf8');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      const verify = await WikiStore.create({ dbPath: wiki.dbPath });
      try {
        const refreshed = verify.db.selectValue("SELECT COUNT(*) FROM wiki_chunk_context_embeddings WHERE page_id = 'people/alice' AND model = '" + DEFAULT_CONTEXTUAL_MODEL + "' AND status = 'done'") as number;
        expect(refreshed).toBeGreaterThan(0);
        expect(verify.db.selectValue("SELECT COUNT(*) FROM wiki_chunk_context_embeddings e LEFT JOIN wiki_chunks c ON c.id = e.chunk_id WHERE c.id IS NULL")).toBe(0);
      } finally {
        verify.close();
      }
    } finally {
      wiki.cleanup();
    }
  });
});
