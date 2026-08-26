/**
 * wiki-coverage.ts — Index coverage gate.
 *
 * A deterministic, no-model check that `wiki_pages` and the wiki tree on disk
 * agree with each other. Written after the 2026-08-12 outage: `wiki_pages`
 * held 301 rows against 326 pages on disk for three days and nothing caught
 * it, because the only standing monitor (`plumb-wiki-search-watchdog`) is a
 * service liveness probe that never inspects index contents.
 *
 * Exclusion-aware by construction: `listWikiPages()` is the same enumeration
 * the indexer (`runWikiEmbed`) walks, so "excluded on purpose" (archive/,
 * SKIP_FILENAMES, SKIP_PREFIXES) and "missing by accident" can never be
 * conflated here. A gate that cannot tell those apart goes noisy and gets
 * ignored, which is worse than no gate.
 *
 * Checks, all read-only:
 *   1. every disk page that passes exclusion has a `wiki_pages` row (missing)
 *   2. every `wiki_pages` row has a file on disk; violations are split into
 *      "file genuinely gone" (ghostsDeleted) vs "file exists but now matches
 *      an exclusion rule" (ghostsExcluded), because the indexer only
 *      adds/updates and never prunes — the split covers both the handoff's
 *      ghost check and its stale-row check in one pass
 *   3. every indexed page's file content still matches its stored
 *      `content_hash` (stale)
 *   4. wiki_chunks count == wiki_chunk_context_embeddings count (catches a
 *      half-indexed state where pages are findable but rank on a degraded
 *      path — this is the second occurrence of that failure mode, see the
 *      2026-08-08 contextual coverage outage)
 *
 * Check 3 is an addition beyond the four the handoff specified, added because
 * probing for it found a live instance on 2026-08-12 (`tools/claude-code.md`
 * edited on disk, index still serving the old text). Presence checks alone
 * cannot see it: the page has a row and a file, so coverage looks perfect
 * while search returns outdated content. An indexer that dies in a week where
 * the user only *edits* pages rather than creating them would be invisible to
 * checks 1, 2 and 4 — the same silent-staleness class as the outage this gate
 * was built for. It is the same comparison `runWikiEmbed` itself makes to
 * decide whether to skip a page, so "stale" here means exactly "the indexer
 * would re-embed this", never a judgement call of our own.
 *
 * Deletion is out of scope here on purpose. `checkWikiCoverage` never writes;
 * `remediateMissingPages` only ever adds/updates via the same incremental
 * `runWikiEmbed` pass the indexer already uses. Pruning ghost rows is a
 * separate, explicit operation left to the raw-transcript boundary work,
 * where it belongs next to the exclusion rules that create ghosts on purpose.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { access, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { listWikiPages, hashContent } from './wiki-fs.js';
import { WikiStore } from './wiki-schema.js';
import { syncWikiLinks, resolveLinksToPage } from './wiki-links.js';
import { runWikiEmbed, type WikiEmbedStats } from './wiki-embedder.js';
import {
  backfillContextualEmbeddings,
  type ContextualBackfillStats,
} from './wiki-contextual-embeddings.js';

export interface WikiCoverageOptions {
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wikiRoot?: string;
  /** Path to wiki.db. Defaults to ~/.plumb/wiki.db */
  dbPath?: string;
}

export interface WikiCoverageReport {
  wikiRoot: string;
  dbPath: string;
  diskCount: number;
  indexedCount: number;
  /** On disk, passes exclusion rules, no wiki_pages row. Indexer never ran for these. */
  missing: string[];
  /** In wiki_pages, but the file no longer exists on disk at all. */
  ghostsDeleted: string[];
  /** In wiki_pages, file still exists on disk but now matches an exclusion rule. */
  ghostsExcluded: string[];
  /**
   * Indexed, on disk, but the file's content no longer hashes to the stored
   * content_hash — the index is serving outdated text for this page.
   */
  stale: string[];
  chunkCount: number;
  contextualCount: number;
  /** chunkCount - contextualCount. Nonzero means a half-indexed state. */
  embeddingGap: number;
  ok: boolean;
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the coverage report. Read-only end to end: `WikiStore.create`
 * applies the schema idempotently (a no-op against an existing db) and
 * nothing here issues a write statement.
 */
export async function checkWikiCoverage(
  options: WikiCoverageOptions = {},
): Promise<WikiCoverageReport> {
  const wikiRoot = options.wikiRoot ?? join(homedir(), '.plumb', 'wiki');
  const dbPath = options.dbPath ?? join(homedir(), '.plumb', 'wiki.db');

  const diskPages = new Set(await listWikiPages(wikiRoot));

  const store = await WikiStore.create({ dbPath });
  try {
    const db = store.db;
    const rows = (db.exec({
      sql: 'SELECT path, content_hash FROM wiki_pages',
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as { path: string; content_hash: string | null }[] | void) ?? [];
    const indexedPaths = rows.map((r) => r.path);
    const indexedSet = new Set(indexedPaths);

    const missing = [...diskPages].filter((p) => !indexedSet.has(p)).sort();

    const ghostsDeleted: string[] = [];
    const ghostsExcluded: string[] = [];
    const stale: string[] = [];
    for (const row of rows) {
      const p = row.path;
      if (!diskPages.has(p)) {
        if (await fileExists(join(wikiRoot, p))) {
          ghostsExcluded.push(p);
        } else {
          ghostsDeleted.push(p);
        }
        continue;
      }
      // Indexed and present: does the file still hash to what we stored?
      // A null stored hash counts as stale for the same reason runWikiEmbed
      // treats it as such — it cannot be shown to be current.
      try {
        const raw = await readFile(join(wikiRoot, p), 'utf8');
        if (row.content_hash === null || row.content_hash !== hashContent(raw)) {
          stale.push(p);
        }
      } catch {
        // Listed but unreadable. Report it rather than silently passing;
        // the embed pass will surface the underlying error properly.
        stale.push(p);
      }
    }
    ghostsDeleted.sort();
    ghostsExcluded.sort();
    stale.sort();

    const chunkCount = Number(db.selectValue('SELECT COUNT(*) FROM wiki_chunks') ?? 0);
    const contextualCount = Number(
      db.selectValue('SELECT COUNT(*) FROM wiki_chunk_context_embeddings') ?? 0,
    );
    const embeddingGap = chunkCount - contextualCount;

    const ok =
      missing.length === 0 &&
      ghostsDeleted.length === 0 &&
      ghostsExcluded.length === 0 &&
      stale.length === 0 &&
      embeddingGap === 0;

    return {
      wikiRoot,
      dbPath,
      diskCount: diskPages.size,
      indexedCount: indexedPaths.length,
      missing,
      ghostsDeleted,
      ghostsExcluded,
      stale,
      chunkCount,
      contextualCount,
      embeddingGap,
      ok,
    };
  } finally {
    store.close();
  }
}

/**
 * Ceiling on how much of the index one prune may remove without `force`.
 *
 * Pruning is driven entirely by "this row's path is no longer in
 * listWikiPages()", so a mistake in the exclusion rules is indistinguishable
 * from a legitimate removal. A `.plumbignore` line of `*` or `/` would mark
 * every page excluded, and an unguarded prune would then delete the entire
 * index in one pass. The wiki itself survives (it is just markdown on disk,
 * and the user's stated position is that wiki.db is a disposable convenience
 * layer) but search would be dead until someone noticed and re-embedded.
 *
 * 20% is well above any real cleanup — the largest known one was 3 rows out
 * of 314 — and far below the blast radius of a bad rule.
 */
export const MAX_PRUNE_FRACTION = 0.2;

export interface PruneOptions extends WikiCoverageOptions {
  /** Bypass the blast-radius guardrail. Never set this from a scheduled job. */
  force?: boolean;
}

export interface PruneResult {
  /** Page paths whose rows were deleted. Empty when nothing was pruned. */
  pruned: string[];
  /** Candidates identified, whether or not they were deleted. */
  candidates: string[];
  /** True when the guardrail declined to act. */
  refused: boolean;
  reason: string | null;
  report: WikiCoverageReport;
}

/**
 * Delete index rows for pages that no longer belong in the index — the ghost
 * rows the coverage gate reports and deliberately never auto-repairs.
 *
 * Both ghost classes are pruned: the file was deleted, or the file still
 * exists but is now excluded (by `.plumbignore`, `archive/`, `SKIP_FILENAMES`
 * or `SKIP_PREFIXES`). The second class is what makes shipping a new
 * exclusion rule actually take effect — the indexer only ever adds and
 * updates, so without this an already-indexed page stays searchable forever
 * no matter what the rules say. Live proof before this existed:
 * `AUDIT_2026-04-16.md` and `EVAL_2026-04-16.md` were still being returned by
 * search months after `SKIP_PREFIXES` was supposed to exclude them.
 *
 * Rows only. Never touches a file on disk — that asymmetry is the whole
 * design: markdown is the source of truth and is recoverable, an index row is
 * derived and regenerable in minutes by the embed pass.
 *
 * `wiki_changelog` history is detached (`page_id` set to NULL) rather than
 * deleted, because it is an append-only audit trail and losing the record
 * that a page once existed is not part of removing it from retrieval.
 */
export async function pruneWikiGhosts(options: PruneOptions = {}): Promise<PruneResult> {
  const wikiRoot = options.wikiRoot ?? join(homedir(), '.plumb', 'wiki');
  const dbPath = options.dbPath ?? join(homedir(), '.plumb', 'wiki.db');
  const force = options.force ?? false;

  const before = await checkWikiCoverage({ wikiRoot, dbPath });
  const candidates = [...before.ghostsDeleted, ...before.ghostsExcluded].sort();

  if (candidates.length === 0) {
    return { pruned: [], candidates, refused: false, reason: null, report: before };
  }

  const fraction = before.indexedCount > 0 ? candidates.length / before.indexedCount : 1;
  if (!force && fraction > MAX_PRUNE_FRACTION) {
    return {
      pruned: [],
      candidates,
      refused: true,
      reason:
        `refusing to prune ${candidates.length} of ${before.indexedCount} indexed pages ` +
        `(${(fraction * 100).toFixed(1)}%, over the ${(MAX_PRUNE_FRACTION * 100).toFixed(0)}% guardrail). ` +
        `This usually means an exclusion rule is wrong rather than that ${candidates.length} pages ` +
        `genuinely left the wiki. Check .plumbignore, then re-run with force if it is correct.`,
      report: before,
    };
  }

  const store = await WikiStore.create({ dbPath });
  try {
    const db = store.db;
    const rows = (db.exec({
      sql: 'SELECT id, path FROM wiki_pages',
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as { id: string; path: string }[] | void) ?? [];
    const doomed = rows.filter((r) => candidates.includes(r.path));

    const run = (sql: string, params: unknown[]): void => {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      stmt.step();
      stmt.finalize();
    };

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { id } of doomed) {
        // Order matters: children before parents, or the foreign keys reject it.
        run('DELETE FROM wiki_chunk_context_embeddings WHERE page_id = ?', [id]);
        run('DELETE FROM wiki_chunks WHERE page_id = ?', [id]);
        run('DELETE FROM wiki_links WHERE source_page_id = ?', [id]);
        // An inbound link from a surviving page becomes unresolved rather than
        // vanishing: the link is still written on that page, it just no longer
        // has a target, and lint should be able to say so.
        run('UPDATE wiki_links SET target_page_id = NULL, resolved = 0 WHERE target_page_id = ?', [id]);
        run('UPDATE wiki_changelog SET page_id = NULL WHERE page_id = ?', [id]);
        run('DELETE FROM wiki_pages WHERE id = ?', [id]);
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw err;
    }
  } finally {
    store.close();
  }

  const report = await checkWikiCoverage({ wikiRoot, dbPath });
  return { pruned: candidates, candidates, refused: false, reason: null, report };
}

export interface WikiCoverageRemediation {
  /** State before any remediation ran. */
  before: WikiCoverageReport;
  /** State after. `after.ok` is the caller's exit-code contract. */
  after: WikiCoverageReport;
  /** Pages the embed pass was asked to fix (missing ∪ stale, pre-remediation). */
  targeted: string[];
  embed: { ran: boolean; stats: WikiEmbedStats | null };
  contextual: { ran: boolean; stats: ContextualBackfillStats | null };
  /**
   * Link-graph repair for this pass.
   *
   * `pages` counts pages whose own outbound rows were rebuilt (they changed).
   * `danglingChecked`/`danglingResolved` cover the other direction: links on
   * OTHER pages that were pointing at nothing and now have a target, because a
   * page they name was created during this pass.
   */
  links: { ran: boolean; pages: number; danglingChecked: number; danglingResolved: number };
  /** True if anything was actually written. False on a clean no-op run. */
  healed: boolean;
}

/**
 * The durable indexing trigger (WI-2), and the reason it lives inside the gate
 * rather than beside it.
 *
 * The 2026-08-12 root cause was never "the reindex broke" — it was that
 * *nothing was calling it*. `~/.plumb/wiki/.git/hooks/post-commit` is a
 * push-to-origin hook, not the re-index hook `installWikiGitHook` writes, and
 * that installer refuses to overwrite a foreign hook by design, so the git
 * path can never self-repair. Even granting all that, the hook it would have
 * installed shells out to a `plumb-wiki` binary that is not on PATH on this
 * host and swallows the failure with `|| true`, and the wiki carries ~90
 * uncommitted files, so commits are not a reliable heartbeat either. Three
 * independent reasons the git-hook option cannot be the trigger; hence the
 * handoff's option 1, where detection and repair are the same code path and
 * there is no separate trigger left to silently die.
 *
 * Additive only, in two passes, both local (Xenova bge-small — no API key, no
 * network, no subscription cost):
 *
 *   1. `runWikiEmbed`, which is incremental by content hash. This repairs
 *      `missing` (never-indexed pages) and `stale` (edited pages) in one
 *      pass, because "stale" is defined as exactly the hash comparison
 *      runWikiEmbed uses to decide whether to skip.
 *   2. `backfillContextualEmbeddings`, only if a contextual gap survives pass
 *      1. Pass 1's `contextualRefresh` covers pages it touched; a gap on
 *      pages it correctly skipped needs this. This is the pass that fixed the
 *      2026-08-08 outage.
 *
 * Never deletes a row, so ghosts survive untouched and keep failing the gate
 * until a human prunes them. That asymmetry is deliberate: adding data back
 * is always recoverable, removing it is not.
 */
export async function remediateWikiCoverage(
  options: WikiCoverageOptions = {},
): Promise<WikiCoverageRemediation> {
  const wikiRoot = options.wikiRoot ?? join(homedir(), '.plumb', 'wiki');
  const dbPath = options.dbPath ?? join(homedir(), '.plumb', 'wiki.db');

  const before = await checkWikiCoverage({ wikiRoot, dbPath });
  const targeted = [...before.missing, ...before.stale].sort();

  let embedStats: WikiEmbedStats | null = null;
  if (targeted.length > 0) {
    embedStats = await runWikiEmbed({ wikiRoot, dbPath, contextualRefresh: true });
  }

  let contextualStats: ContextualBackfillStats | null = null;
  const afterEmbed = targeted.length > 0
    ? await checkWikiCoverage({ wikiRoot, dbPath })
    : before;

  if (afterEmbed.embeddingGap !== 0) {
    const store = await WikiStore.create({ dbPath });
    try {
      contextualStats = await backfillContextualEmbeddings({ db: store.db });
    } finally {
      store.close();
    }
  }

  const after = contextualStats !== null
    ? await checkWikiCoverage({ wikiRoot, dbPath })
    : afterEmbed;

  // Link graph, for exactly the pages just re-indexed.
  //
  // ADDED 2026-08-14. Nothing in the current cron set maintained `wiki_links`
  // at all: the legacy `plumb wiki dream` CLI called `link-rebuild`, the
  // TypeScript nightly dream that replaced it on 2026-08-08 does not, and the
  // Claude queue worker edits page FILES directly rather than going through
  // WaaS, which is the only caller of `syncWikiLinks`. The table had been
  // frozen since 2026-08-03 — pages created after that date had no link rows at
  // all — so `plumb_wiki_links` was serving an eleven-day-old graph.
  //
  // It lives here for the same reason the stale-page check does (WI-2): the
  // pass that already knows which pages changed is the one that can fix them,
  // so there is no separate trigger left to die quietly. Best-effort by design;
  // a link-sync failure must not fail an otherwise successful re-index.
  let linksSynced = 0;
  let danglingChecked = 0;
  let danglingResolved = 0;
  if (targeted.length > 0) {
    const store = await WikiStore.create({ dbPath });
    try {
      for (const relPath of targeted) {
        try {
          const raw = readFileSync(join(wikiRoot, relPath), 'utf8');
          syncWikiLinks(store.db, relPath.replace(/\.md$/, ''), raw, wikiRoot);
          linksSynced++;
        } catch {
          // A page that cannot be read was already counted as drift above.
        }
      }

      // The OTHER direction, added 2026-08-14.
      //
      // The loop above only rewrites rows whose SOURCE page changed. A page
      // being CREATED is the case that needs the reverse: every page that
      // already linked to it is still carrying `resolved = 0` and will keep
      // carrying it until that page happens to change for an unrelated reason.
      // Live instance: creating `companies/halcyon.md` left
      // `people/robin-vance.md`'s `[[Halcyon]]` row unresolved. A full
      // `link-rebuild` masks this; the incremental path that actually runs
      // every 15 minutes does not, so between rebuilds the graph drifts one
      // way — under-reporting inbound edges to exactly the newest pages.
      //
      // Gated on `before.missing` rather than on `targeted`, because only a
      // page that was ABSENT from the index can turn someone else's dangling
      // link into a resolvable one. Re-indexing an edited page cannot, and
      // paying for a whole-graph sweep on every content edit would make the
      // common case (a page the user just edited) the expensive one.
      if (before.missing.length > 0) {
        const swept = resolveLinksToPage(store.db, wikiRoot);
        danglingChecked = swept.checked;
        danglingResolved = swept.resolved;
      }
    } finally {
      store.close();
    }
  }

  return {
    before,
    after,
    targeted,
    embed: { ran: embedStats !== null, stats: embedStats },
    contextual: { ran: contextualStats !== null, stats: contextualStats },
    links: { ran: linksSynced > 0, pages: linksSynced, danglingChecked, danglingResolved },
    healed:
      embedStats !== null || contextualStats !== null || linksSynced > 0 || danglingResolved > 0,
  };
}
