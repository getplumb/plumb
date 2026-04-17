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
  extractWikilinks,
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
        const { body } = parseFrontmatter(raw);
        linkCount += extractWikilinks(body).length;
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

    // Build title → page_id map from wiki_pages for resolution
    const pageRows = db.exec({
      sql: 'SELECT id, title FROM wiki_pages',
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{ id: string; title: string }>;

    const titleToId = new Map<string, string>();
    const slugToId = new Map<string, string>();
    for (const row of pageRows) {
      if (row.title) {
        titleToId.set(row.title.toLowerCase(), row.id);
      }
      if (row.id) {
        // Also index by basename slug (last segment after /)
        const slug = row.id.replace(/^.*\//, '').toLowerCase();
        slugToId.set(slug, row.id);
      }
    }

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

      let body: string;
      try {
        ({ body } = parseFrontmatter(raw));
      } catch {
        body = raw;
      }

      const targets = extractWikilinks(body);
      if (targets.length === 0) {
        pagesProcessed++;
        continue;
      }

      // Derive source_page_id: relPath without .md
      const sourcePageId = relPath.replace(/\.md$/, '');

      for (const target of targets) {
        // Strip alias: [[Name|display]] → "Name"
        const targetName = (target.split('|')[0] ?? target).trim();
        if (!targetName) continue;

        // Try to resolve to a page ID
        const lowerTitle = targetName.toLowerCase();
        const slug = targetName
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '');

        const resolvedId = titleToId.get(lowerTitle) ?? slugToId.get(slug) ?? null;
        const resolved = resolvedId !== null ? 1 : 0;

        const stmt = db.prepare(
          'INSERT INTO wiki_links (source_page_id, target_title, target_page_id, resolved) VALUES (?, ?, ?, ?)',
        );
        stmt.bind([sourcePageId, targetName, resolvedId, resolved]);
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
