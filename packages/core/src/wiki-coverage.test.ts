/**
 * Unit tests for wiki-coverage.ts
 *
 * Tests cover:
 *   - clean state: disk and db agree -> ok
 *   - missing: a page on disk with no wiki_pages row
 *   - ghosts (deleted): a wiki_pages row whose file no longer exists
 *   - ghosts (excluded): a wiki_pages row whose file still exists but now
 *     matches an exclusion rule (SKIP_PREFIXES / archive/)
 *   - embedding gap: wiki_chunks vs wiki_chunk_context_embeddings mismatch
 *   - remediateMissingPages: additive-only, closes the "missing" gap and
 *     never touches ghost rows
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWikiCoverage, remediateWikiCoverage, pruneWikiGhosts } from './wiki-coverage.js';
import { runWikiEmbed } from './wiki-embedder.js';
import { WikiStore } from './wiki-schema.js';

function tempWiki(): { root: string; dbPath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'wiki-coverage-test-'));
  return { root, dbPath: join(root, 'wiki.db'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writePage(root: string, relPath: string, title: string): void {
  const absPath = join(root, relPath);
  mkdirSync(join(absPath, '..'), { recursive: true });
  writeFileSync(
    absPath,
    `---\ntype: person\ncreated: 2026-08-01\nupdated: 2026-08-01\nsource_refs: []\ntags: []\nconfidence: high\n---\n# ${title}\n\nBody text for ${title}.\n`,
    'utf8',
  );
}

describe('checkWikiCoverage', () => {
  it('reports ok on a fully in-sync wiki', async () => {
    const wiki = tempWiki();
    try {
      writePage(wiki.root, 'people/alice.md', 'Alice');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath, contextualRefresh: true });

      const report = await checkWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      expect(report.ok).toBe(true);
      expect(report.missing).toEqual([]);
      expect(report.ghostsDeleted).toEqual([]);
      expect(report.ghostsExcluded).toEqual([]);
      expect(report.stale).toEqual([]);
      expect(report.embeddingGap).toBe(0);
      expect(report.diskCount).toBe(1);
      expect(report.indexedCount).toBe(1);
    } finally {
      wiki.cleanup();
    }
  });

  it('flags a page on disk that was never indexed (the 2026-08-12 outage shape)', async () => {
    const wiki = tempWiki();
    try {
      writePage(wiki.root, 'people/alice.md', 'Alice');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      // A second page lands on disk but the indexer never runs again --
      // exactly what happened when the push-to-origin hook silently replaced
      // the re-index hook.
      writePage(wiki.root, 'people/bob.md', 'Bob');

      const report = await checkWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      expect(report.ok).toBe(false);
      expect(report.missing).toEqual(['people/bob.md']);
      expect(report.ghostsDeleted).toEqual([]);
      expect(report.ghostsExcluded).toEqual([]);
    } finally {
      wiki.cleanup();
    }
  });

  it('classifies a ghost row whose file was deleted from disk', async () => {
    const wiki = tempWiki();
    try {
      writePage(wiki.root, 'people/alice.md', 'Alice');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      rmSync(join(wiki.root, 'people/alice.md'));

      const report = await checkWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      expect(report.ok).toBe(false);
      expect(report.ghostsDeleted).toEqual(['people/alice.md']);
      expect(report.ghostsExcluded).toEqual([]);
      expect(report.missing).toEqual([]);
    } finally {
      wiki.cleanup();
    }
  });

  it('classifies a ghost row whose file still exists but now matches an exclusion rule', async () => {
    const wiki = tempWiki();
    try {
      // AUDIT_old.md is excluded by SKIP_PREFIXES today, so runWikiEmbed would
      // never index it. Insert the row directly to reproduce the live
      // AUDIT_2026-04-16.md / EVAL_2026-04-16.md shape from the handoff: rows
      // indexed before the exclusion rule existed, still on disk, never pruned.
      writePage(wiki.root, 'AUDIT_old.md', 'Old Audit');
      const store = await WikiStore.create({ dbPath: wiki.dbPath });
      try {
        store.db.exec(
          "INSERT INTO wiki_pages (id, path, type, title, created, updated, confidence, tags, source_refs, status) " +
            "VALUES ('AUDIT_old', 'AUDIT_old.md', 'report', 'Old Audit', '2026-04-16', '2026-04-16', 'high', '[]', '[]', 'active')",
        );
      } finally {
        store.close();
      }

      const report = await checkWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      expect(report.ok).toBe(false);
      expect(report.ghostsExcluded).toEqual(['AUDIT_old.md']);
      expect(report.ghostsDeleted).toEqual([]);
      expect(report.missing).toEqual([]);
    } finally {
      wiki.cleanup();
    }
  });

  it('flags a nonzero gap between wiki_chunks and wiki_chunk_context_embeddings', async () => {
    const wiki = tempWiki();
    try {
      writePage(wiki.root, 'people/alice.md', 'Alice');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath, contextualRefresh: true });

      const store = await WikiStore.create({ dbPath: wiki.dbPath });
      try {
        // Simulate the 2026-08-08 contextual coverage outage shape: chunks
        // exist but their contextual sidecar rows never landed.
        store.db.exec('DELETE FROM wiki_chunk_context_embeddings');
      } finally {
        store.close();
      }

      const report = await checkWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      expect(report.ok).toBe(false);
      expect(report.embeddingGap).toBeGreaterThan(0);
      expect(report.contextualCount).toBe(0);
      expect(report.chunkCount).toBeGreaterThan(0);
    } finally {
      wiki.cleanup();
    }
  });

  it('flags an indexed page whose file changed after indexing', async () => {
    const wiki = tempWiki();
    try {
      writePage(wiki.root, 'people/alice.md', 'Alice');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath, contextualRefresh: true });
      expect((await checkWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath })).ok).toBe(true);

      // Edit the page without re-indexing. Presence checks still pass -- the
      // row exists and the file exists -- but search now serves stale text.
      // This is the shape found live on 2026-08-12 (tools/claude-code.md).
      writePage(wiki.root, 'people/alice.md', 'Alice Revised');

      const report = await checkWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      expect(report.ok).toBe(false);
      expect(report.stale).toEqual(['people/alice.md']);
      expect(report.missing).toEqual([]);
      expect(report.ghostsDeleted).toEqual([]);
    } finally {
      wiki.cleanup();
    }
  });

  it('treats a null stored content_hash as stale, matching what the indexer would do', async () => {
    const wiki = tempWiki();
    try {
      writePage(wiki.root, 'people/alice.md', 'Alice');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath, contextualRefresh: true });

      const store = await WikiStore.create({ dbPath: wiki.dbPath });
      try {
        store.db.exec("UPDATE wiki_pages SET content_hash = NULL WHERE id = 'people/alice'");
      } finally {
        store.close();
      }

      const report = await checkWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      expect(report.stale).toEqual(['people/alice.md']);
    } finally {
      wiki.cleanup();
    }
  });

  it('names the deleted page in a useful way (negative-control shape)', async () => {
    const wiki = tempWiki();
    try {
      writePage(wiki.root, 'people/alice.md', 'Alice');
      writePage(wiki.root, 'people/bob.md', 'Bob');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      const store = await WikiStore.create({ dbPath: wiki.dbPath });
      try {
        // Respect the FK: wiki_chunks.page_id references wiki_pages.id, so a
        // hand-deleted page's chunks must go first, matching how the real
        // negative control (delete one page's rows from a DB copy) is done.
        store.db.exec("DELETE FROM wiki_chunks WHERE page_id = 'people/bob'");
        store.db.exec("DELETE FROM wiki_pages WHERE id = 'people/bob'");
      } finally {
        store.close();
      }

      const report = await checkWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      expect(report.ok).toBe(false);
      expect(report.missing).toEqual(['people/bob.md']);
    } finally {
      wiki.cleanup();
    }
  });
});

describe('.plumbignore boundary', () => {
  it('excludes an ignored folder and everything nested beneath it', async () => {
    const wiki = tempWiki();
    try {
      writePage(wiki.root, 'people/alice.md', 'Alice');
      writePage(wiki.root, 'transcripts/calls/2026-08-12-kei.md', 'Kei Call');
      writePage(wiki.root, 'transcripts/interviews/deep/nested.md', 'Nested');
      writeFileSync(join(wiki.root, '.plumbignore'), '# raw transcripts\ntranscripts/\n', 'utf8');

      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath, contextualRefresh: true });
      const report = await checkWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      // The ignored pages are not "missing" -- they are correctly outside the
      // boundary, which is the distinction the gate exists to preserve.
      expect(report.ok).toBe(true);
      expect(report.diskCount).toBe(1);
      expect(report.missing).toEqual([]);
      expect(report.indexedCount).toBe(1);
    } finally {
      wiki.cleanup();
    }
  });

  it('turns a previously indexed page into an excluded ghost when a rule is added', async () => {
    const wiki = tempWiki();
    try {
      writePage(wiki.root, 'people/alice.md', 'Alice');
      writePage(wiki.root, 'transcripts/calls/kei.md', 'Kei Call');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath, contextualRefresh: true });
      expect((await checkWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath })).indexedCount).toBe(2);

      // Ship the exclusion after the fact. The indexer never prunes, so the
      // row survives and the page stays searchable until pruned -- exactly
      // what happened with AUDIT_/EVAL_ for months.
      writeFileSync(join(wiki.root, '.plumbignore'), 'transcripts/\n', 'utf8');

      const report = await checkWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });
      expect(report.ok).toBe(false);
      expect(report.ghostsExcluded).toEqual(['transcripts/calls/kei.md']);
      expect(report.ghostsDeleted).toEqual([]);
    } finally {
      wiki.cleanup();
    }
  });
});

describe('pruneWikiGhosts', () => {
  it('removes an excluded ghost and leaves the gate green, without touching the file', async () => {
    const wiki = tempWiki();
    try {
      // Enough surviving pages that pruning one stays under the guardrail;
      // the guardrail itself is exercised separately below.
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
        writePage(wiki.root, `people/${name}.md`, name.toUpperCase());
      }
      writePage(wiki.root, 'transcripts/calls/kei.md', 'Kei Call');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath, contextualRefresh: true });
      writeFileSync(join(wiki.root, '.plumbignore'), 'transcripts/\n', 'utf8');

      const result = await pruneWikiGhosts({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      expect(result.refused).toBe(false);
      expect(result.pruned).toEqual(['transcripts/calls/kei.md']);
      expect(result.report.ok).toBe(true);
      expect(result.report.embeddingGap).toBe(0);
      // The transcript itself must still be on disk -- only its index row went.
      expect(existsSync(join(wiki.root, 'transcripts/calls/kei.md'))).toBe(true);
    } finally {
      wiki.cleanup();
    }
  });

  it('refuses to prune more than the guardrail allows, and force overrides it', async () => {
    const wiki = tempWiki();
    try {
      for (const name of ['a', 'b', 'c', 'd', 'e']) {
        writePage(wiki.root, `people/${name}.md`, name.toUpperCase());
      }
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath, contextualRefresh: true });

      // The catastrophic-rule case: a pattern that excludes the whole wiki.
      writeFileSync(join(wiki.root, '.plumbignore'), 'people/\n', 'utf8');

      const refused = await pruneWikiGhosts({ wikiRoot: wiki.root, dbPath: wiki.dbPath });
      expect(refused.refused).toBe(true);
      expect(refused.pruned).toEqual([]);
      expect(refused.reason).toContain('guardrail');
      // Nothing was deleted, so the rows are all still there to inspect.
      expect(refused.report.indexedCount).toBe(5);

      const forced = await pruneWikiGhosts({ wikiRoot: wiki.root, dbPath: wiki.dbPath, force: true });
      expect(forced.refused).toBe(false);
      expect(forced.pruned).toHaveLength(5);
      expect(forced.report.indexedCount).toBe(0);
    } finally {
      wiki.cleanup();
    }
  });

  it('detaches changelog history instead of deleting it', async () => {
    const wiki = tempWiki();
    try {
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
        writePage(wiki.root, `people/${name}.md`, name.toUpperCase());
      }
      writePage(wiki.root, 'transcripts/kei.md', 'Kei');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath, contextualRefresh: true });

      const store = await WikiStore.create({ dbPath: wiki.dbPath });
      try {
        store.db.exec(
          "INSERT INTO wiki_changelog (page_id, action, detail, created_at) " +
            "VALUES ('transcripts/kei', 'created', 'test', '2026-08-12T00:00:00Z')",
        );
      } finally {
        store.close();
      }

      writeFileSync(join(wiki.root, '.plumbignore'), 'transcripts/\n', 'utf8');
      await pruneWikiGhosts({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      const verify = await WikiStore.create({ dbPath: wiki.dbPath });
      try {
        const rows = verify.db.exec({
          sql: "SELECT page_id FROM wiki_changelog WHERE action = 'created' AND detail = 'test'",
          rowMode: 'object',
          returnValue: 'resultRows',
        }) as { page_id: string | null }[];
        expect(rows).toHaveLength(1);
        expect(rows[0]!.page_id).toBeNull();
      } finally {
        verify.close();
      }
    } finally {
      wiki.cleanup();
    }
  });
});

describe('remediateWikiCoverage', () => {
  it('is a no-op that writes nothing when the index is already clean', async () => {
    const wiki = tempWiki();
    try {
      writePage(wiki.root, 'people/alice.md', 'Alice');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath, contextualRefresh: true });

      const result = await remediateWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      expect(result.healed).toBe(false);
      expect(result.embed.ran).toBe(false);
      expect(result.contextual.ran).toBe(false);
      expect(result.after.ok).toBe(true);
    } finally {
      wiki.cleanup();
    }
  });

  it('re-indexes a stale page so search stops serving the old content', async () => {
    const wiki = tempWiki();
    try {
      writePage(wiki.root, 'people/alice.md', 'Alice');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath, contextualRefresh: true });
      writePage(wiki.root, 'people/alice.md', 'Alice Revised');

      const result = await remediateWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      expect(result.before.stale).toEqual(['people/alice.md']);
      expect(result.targeted).toEqual(['people/alice.md']);
      expect(result.healed).toBe(true);
      expect(result.after.ok).toBe(true);
      expect(result.after.stale).toEqual([]);

      // The new text must actually be in the chunks, not just the hash updated.
      const store = await WikiStore.create({ dbPath: wiki.dbPath });
      try {
        const chunks = store.db.exec({
          sql: "SELECT content FROM wiki_chunks WHERE page_id = 'people/alice'",
          rowMode: 'object',
          returnValue: 'resultRows',
        }) as { content: string }[];
        expect(chunks.map((c) => c.content).join('\n')).toContain('Alice Revised');
      } finally {
        store.close();
      }
    } finally {
      wiki.cleanup();
    }
  });

  it('closes a contextual gap left on pages the embed pass correctly skipped', async () => {
    const wiki = tempWiki();
    try {
      writePage(wiki.root, 'people/alice.md', 'Alice');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath, contextualRefresh: true });

      // Gap with nothing missing and nothing stale: the embed pass will skip
      // every page on hash, so only the backfill can close this.
      const store = await WikiStore.create({ dbPath: wiki.dbPath });
      try {
        store.db.exec('DELETE FROM wiki_chunk_context_embeddings');
      } finally {
        store.close();
      }

      const result = await remediateWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      expect(result.before.embeddingGap).toBeGreaterThan(0);
      expect(result.embed.ran).toBe(false);
      expect(result.contextual.ran).toBe(true);
      expect(result.after.embeddingGap).toBe(0);
      expect(result.after.ok).toBe(true);
    } finally {
      wiki.cleanup();
    }
  });

  it('closes the missing gap additively without touching ghost rows', async () => {
    const wiki = tempWiki();
    try {
      writePage(wiki.root, 'people/alice.md', 'Alice');
      await runWikiEmbed({ wikiRoot: wiki.root, dbPath: wiki.dbPath, contextualRefresh: true });

      // A ghost that should survive remediation untouched.
      const store = await WikiStore.create({ dbPath: wiki.dbPath });
      try {
        store.db.exec(
          "INSERT INTO wiki_pages (id, path, type, title, created, updated, confidence, tags, source_refs, status) " +
            "VALUES ('projects/ghost', 'projects/ghost.md', 'project', 'Ghost', '2026-01-01', '2026-01-01', 'high', '[]', '[]', 'active')",
        );
      } finally {
        store.close();
      }

      writePage(wiki.root, 'people/bob.md', 'Bob');

      const before = await checkWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });
      expect(before.missing).toEqual(['people/bob.md']);
      expect(before.ghostsDeleted).toEqual(['projects/ghost.md']);

      const { after } = await remediateWikiCoverage({ wikiRoot: wiki.root, dbPath: wiki.dbPath });

      expect(after.missing).toEqual([]);
      // The remediated page must land with its contextual sidecar rows, not
      // just wiki_pages/wiki_chunks — a never-indexed page has no existing
      // contextual rows, so without contextualRefresh runWikiEmbed skips the
      // sidecar and remediation would trade check 1 for check 4.
      expect(after.embeddingGap).toBe(0);
      // The additive pass must not have pruned the pre-existing ghost.
      expect(after.ghostsDeleted).toEqual(['projects/ghost.md']);
    } finally {
      wiki.cleanup();
    }
  });
});
