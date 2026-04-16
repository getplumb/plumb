/**
 * wiki-links.ts — Wikilink parser and graph population for Plumb wiki.
 *
 * Provides:
 *   - extractWikilinks()      Extract [[Link]] targets from markdown text
 *   - syncWikiLinks()         UPSERT wiki_links table for a page, removing stale links
 */

import type { WasmDb } from './wasm-db.js';

// ---------------------------------------------------------------------------
// Wikilink extraction
// ---------------------------------------------------------------------------

/**
 * Regex to match [[wikilink]] patterns.
 *
 * Supports:
 *   [[Target]]                — simple link; target = "Target"
 *   [[Target|Display Text]]   — piped link; target = "Target"
 *
 * Captures the target (left of | or entire content if no |).
 * Ignores empty brackets [[]] and allows spaces inside the brackets.
 */
const WIKILINK_REGEX = /\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g;

/**
 * Extract all [[wikilink]] targets from a markdown string.
 *
 * - Returns the raw text inside the brackets (left side if piped).
 * - Trims whitespace from each target.
 * - Deduplicates: each unique target appears once.
 * - Skips empty targets.
 *
 * @param text  Markdown body text to scan
 * @returns     Sorted array of unique wikilink target strings
 */
export function extractWikilinks(text: string): string[] {
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  WIKILINK_REGEX.lastIndex = 0;
  while ((match = WIKILINK_REGEX.exec(text)) !== null) {
    const target = (match[1] ?? '').trim();
    if (target.length > 0) {
      seen.add(target);
    }
  }

  return Array.from(seen).sort();
}

// ---------------------------------------------------------------------------
// wiki_links table population
// ---------------------------------------------------------------------------

/**
 * Row shape returned when querying wiki_links.
 */
interface WikiLinkRow {
  id: number;
  target_title: string;
  target_page_id: string | null;
  resolved: number;
}

/**
 * Synchronize the wiki_links table for a given source page.
 *
 * Algorithm:
 *   1. Parse current wikilink targets from the page body.
 *   2. Delete all existing rows for this source_page_id.
 *   3. For each target, try to resolve it to a wiki_pages.id:
 *      - Exact match on wiki_pages.title
 *      - If unresolved, target_page_id is NULL and resolved = 0.
 *   4. Insert one row per unique target.
 *
 * This "delete + re-insert" approach is simpler and more correct than
 * trying to diff: it naturally handles renames, removals, and additions.
 *
 * @param db            Open database connection with wiki schema applied
 * @param sourcePageId  wiki_pages.id of the page being updated
 * @param body          Current markdown body text of the page
 */
export function syncWikiLinks(db: WasmDb, sourcePageId: string, body: string): void {
  const targets = extractWikilinks(body);

  // Delete all existing links from this source page
  db.exec(`DELETE FROM wiki_links WHERE source_page_id = '${escSql(sourcePageId)}'`);

  if (targets.length === 0) return;

  // Build a title → page_id lookup from wiki_pages for resolution
  const pageRows = db.exec({
    sql: 'SELECT id, title FROM wiki_pages',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ id: string; title: string }>;

  const titleToId = new Map<string, string>();
  for (const row of pageRows) {
    if (row.title) {
      titleToId.set(row.title.toLowerCase(), row.id);
    }
  }

  // Insert one row per unique target.
  // Prepare a fresh statement for each row — CompatStatement does not support
  // re-binding and re-stepping a DML statement after the first execution.
  for (const target of targets) {
    const resolvedId = titleToId.get(target.toLowerCase()) ?? null;
    const resolved = resolvedId !== null ? 1 : 0;
    const stmt = db.prepare(
      'INSERT INTO wiki_links (source_page_id, target_title, target_page_id, resolved) VALUES (?, ?, ?, ?)',
    );
    stmt.bind([sourcePageId, target, resolvedId, resolved]);
    stmt.step();
    stmt.finalize();
  }
}

/**
 * Re-evaluate resolved/unresolved status for all wiki_links that point to a
 * given title. Call this after a new page is created or a page title changes
 * so that previously-dangling links can be marked resolved.
 *
 * @param db         Open database connection with wiki schema applied
 * @param pageTitle  The page title that was just created or renamed to
 * @param pageId     The wiki_pages.id for that page
 */
export function resolveLinksToPage(db: WasmDb, pageTitle: string, pageId: string): void {
  db.exec(
    `UPDATE wiki_links
        SET target_page_id = '${escSql(pageId)}',
            resolved = 1
      WHERE LOWER(target_title) = LOWER('${escSql(pageTitle)}')
        AND resolved = 0`,
  );
}

/**
 * Return all outbound links from a page (the links it contains).
 *
 * @param db           Open database connection
 * @param sourcePageId wiki_pages.id of the source page
 */
export function getOutboundLinks(db: WasmDb, sourcePageId: string): WikiLinkRow[] {
  return db.exec({
    sql: `SELECT id, target_title, target_page_id, resolved
            FROM wiki_links
           WHERE source_page_id = '${escSql(sourcePageId)}'
           ORDER BY target_title`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as WikiLinkRow[];
}

/**
 * Return all inbound links to a page (pages that link to it).
 *
 * @param db          Open database connection
 * @param targetPageId wiki_pages.id of the target page
 */
export function getInboundLinks(
  db: WasmDb,
  targetPageId: string,
): Array<{ id: number; source_page_id: string; target_title: string }> {
  return db.exec({
    sql: `SELECT id, source_page_id, target_title
            FROM wiki_links
           WHERE target_page_id = '${escSql(targetPageId)}'
           ORDER BY source_page_id`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ id: number; source_page_id: string; target_title: string }>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Minimal SQL string escaping: double any single-quote characters.
 * Used only for string literals embedded directly in SQL strings.
 * Parameterized queries are preferred; this covers the cases where we
 * inline values into exec() strings for simplicity.
 */
function escSql(value: string): string {
  return value.replace(/'/g, "''");
}
