/**
 * wiki-link-rebuild.ts — Deterministic link-graph rebuild for the nightly dream cron (T-239).
 *
 * Rebuilds the wiki_links table from scratch by:
 *   1. Deleting ALL rows from wiki_links (clean slate)
 *   2. Walking every wiki page
 *   3. Parsing [[wikilink]] targets from each page's body
 *   4. Inserting fresh rows, resolving target_page_id where possible
 *
 * This is purely deterministic — no AI, no incremental mutations.
 * The table is treated as a derived view of the markdown source of truth.
 *
 * Usage (command):
 *   plumb wiki link-rebuild [--wiki <path>] [--db <path>] [--dry-run]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  openDb,
  applyWikiSchema,
  listWikiPages,
  parseWikilinks,
  resolveWikilink,
  buildResolveIndex,
  type WikiPageInput,
  parseFrontmatter,
  extractTitle,
} from '@getplumb/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiLinkRebuildOptions {
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** Path to wiki.db. Defaults to ~/.plumb/wiki.db */
  db?: string;
  /** If true, print what would happen but do not modify the database */
  dryRun?: boolean;
}

export interface WikiLinkRebuildResult {
  pagesProcessed: number;
  linksInserted: number;
  linksResolved: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PageRecord {
  /** The page ID: relative path without .md, e.g. "people/alice" */
  id: string;
  /** Lowercase page title for resolution */
  titleLower: string;
}

// ---------------------------------------------------------------------------
// Main rebuild function
// ---------------------------------------------------------------------------

/**
 * Rebuild the wiki_links table deterministically from markdown on disk.
 *
 * Steps:
 *   1. Load all wiki pages, build a title→id resolution map from wiki_pages.
 *   2. DELETE FROM wiki_links (full truncation — this is the "deterministic" part).
 *   3. For every page on disk, extract wikilinks and INSERT into wiki_links.
 *
 * Returns counts for logging.
 */
export async function rebuildWikiLinks(
  wikiRoot: string,
  wikiDbPath: string,
  dryRun: boolean,
): Promise<WikiLinkRebuildResult> {
  if (!existsSync(wikiRoot)) {
    return { pagesProcessed: 0, linksInserted: 0, linksResolved: 0 };
  }

  // Enumerate all wiki pages from disk
  const relPaths = await listWikiPages(wikiRoot);
  if (relPaths.length === 0) {
    return { pagesProcessed: 0, linksInserted: 0, linksResolved: 0 };
  }

  if (dryRun) {
    // In dry-run mode, just count what would happen without touching the DB
    let linkCount = 0;
    for (const relPath of relPaths) {
      const absPath = join(wikiRoot, relPath);
      try {
        const raw = readFileSync(absPath, 'utf8');
        linkCount += parseWikilinks(raw).filter((l) => l.target.length > 0).length;
      } catch {
        // skip unreadable pages
      }
    }
    return {
      pagesProcessed: relPaths.length,
      linksInserted: linkCount,
      linksResolved: 0,
    };
  }

  // Open wiki.db, apply schema so tables exist
  const db = await openDb(wikiDbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    applyWikiSchema(db);

    // Resolution index, from the canonical resolver.
    //
    // REWIRED 2026-08-14. This command had its OWN title map and slug rule —
    // the fourth independent link resolver in the repo — and because it
    // truncates and rebuilds all of `wiki_links`, it would silently undo the
    // fix in `syncWikiLinks` on its next run. Anything that writes the link
    // graph must resolve the same way as everything that reads it.
    const pageRows = db.exec({
      sql: 'SELECT id, path, title FROM wiki_pages',
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{ id: string; path: string; title: string }>;

    // Built from the FILES, not from `wiki_pages`, because `wiki_pages` has no
    // aliases column and aliases are the tier most cross-references match on
    // (`[[the user]]`, `[[Dana Rivera]]`, `[[O3]]`). This command already reads
    // every page, so the file-based index costs nothing extra here.
    const corpus: WikiPageInput[] = [];
    const relToId = new Map<string, string>();
    for (const row of pageRows) {
      if (!row.path) continue;
      relToId.set(row.path, row.id);
    }
    for (const relPath of relPaths) {
      try {
        corpus.push({ rel: relPath, text: readFileSync(join(wikiRoot, relPath), 'utf8') });
      } catch {
        // Unreadable pages simply cannot be link targets.
      }
    }
    const resolveIndex = buildResolveIndex(corpus);

    // Step 2: Truncate wiki_links (deterministic clean slate)
    db.exec('DELETE FROM wiki_links');

    // Step 3: Process each page and insert links
    let linksInserted = 0;
    let linksResolved = 0;
    let pagesProcessed = 0;

    for (const relPath of relPaths) {
      const absPath = join(wikiRoot, relPath);
      let raw: string;
      try {
        raw = readFileSync(absPath, 'utf8');
      } catch {
        continue;
      }

      // The resolver reads `aliases:` from the frontmatter itself, so the whole
      // file is parsed rather than the body alone.
      const links = parseWikilinks(raw);
      if (links.length === 0) {
        pagesProcessed++;
        continue;
      }

      // Derive source_page_id: relPath without .md
      const sourcePageId = relPath.replace(/\.md$/, '');

      const seen = new Set<string>();
      for (const link of links) {
        // Same-page `[[#anchor]]` links are intra-page navigation, not edges.
        if (link.target.length === 0) continue;
        if (seen.has(link.target)) continue;
        seen.add(link.target);

        const res = resolveWikilink(resolveIndex, relPath, link);
        // A page naming itself is not an edge; see syncWikiLinks.
        if (res.targetRel !== null && res.targetRel === relPath) continue;
        const resolvedId = res.targetRel === null ? null : (relToId.get(res.targetRel) ?? null);
        const resolved = resolvedId !== null ? 1 : 0;

        const stmt = db.prepare(
          'INSERT INTO wiki_links (source_page_id, target_title, target_page_id, resolved) VALUES (?, ?, ?, ?)',
        );
        stmt.bind([sourcePageId, link.target, resolvedId, resolved]);
        stmt.step();
        stmt.finalize();

        linksInserted++;
        if (resolved) linksResolved++;
      }

      pagesProcessed++;
    }

    // Persist changes (for WASM SQLite, flush to storage)
    try {
      (db as unknown as { export?: () => Uint8Array }).export?.();
    } catch {
      // Non-fatal
    }

    return { pagesProcessed, linksInserted, linksResolved };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Exported command
// ---------------------------------------------------------------------------

export async function wikiLinkRebuildCommand(
  options: WikiLinkRebuildOptions = {},
): Promise<WikiLinkRebuildResult> {
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');
  const wikiDbPath = options.db ?? join(homedir(), '.plumb', 'wiki.db');
  const dryRun = options.dryRun ?? false;

  console.log('Wiki link-graph rebuild…');
  console.log(`  wiki: ${wikiRoot}`);
  console.log(`  db:   ${wikiDbPath}`);
  if (dryRun) console.log('  [dry-run mode]');

  const result = await rebuildWikiLinks(wikiRoot, wikiDbPath, dryRun);

  console.log(`  Pages processed: ${result.pagesProcessed}`);
  console.log(`  Links inserted:  ${result.linksInserted}`);
  console.log(`  Links resolved:  ${result.linksResolved}`);

  return result;
}
