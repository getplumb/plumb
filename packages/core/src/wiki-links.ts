/**
 * wiki-links.ts — Wikilink parser and graph population for Plumb wiki.
 *
 * Provides:
 *   - extractWikilinks()      Extract [[Link]] targets from markdown text
 *   - syncWikiLinks()         UPSERT wiki_links table for a page, removing stale links
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { WasmDb } from './wasm-db.js';
import {
  buildResolveIndexFromMeta,
  extractAliases,
  parseWikilinks,
  resolveWikilink,
  type WikiPageMeta,
} from './wiki-resolve.js';

/** Frontmatter aliases for one page; empty when the file cannot be read. */
function readAliasesFromDisk(wikiRoot: string, relPath: string): string[] {
  try {
    return extractAliases(readFileSync(join(wikiRoot, relPath), 'utf8'));
  } catch {
    return [];
  }
}

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
 *   1. Parse current wikilink targets from the page body, ignoring frontmatter
 *      and code.
 *   2. Delete all existing rows for this source_page_id.
 *   3. Resolve each target through the canonical resolver (`wiki-resolve.ts`).
 *   4. Insert one row per unique target.
 *
 * This "delete + re-insert" approach is simpler and more correct than
 * trying to diff: it naturally handles renames, removals, and additions.
 *
 * REWRITTEN 2026-08-14. This function previously resolved targets by an EXACT
 * lowercased match on `wiki_pages.title` and nothing else, which meant the
 * `wiki_links` table — and therefore the `plumb_wiki_links` MCP tool built on
 * it — silently dropped every link written as a path (`[[people/karthik]]`),
 * with a `.md` suffix, or by display name against a kebab-case filename
 * (`[[Taylor Angevine]]` → `people/taylor-angevine.md`, 23 live occurrences).
 * It also recorded links appearing inside code spans as real edges.
 *
 * That mattered well beyond link counts: the wikilink graph is the propagation
 * index the wiki pipeline uses to decide which OTHER pages a changed fact must
 * update. A lossy graph is a silent hole in that fan-out, so this is the
 * correctness fix the rest of the pipeline rests on.
 *
 * Same-page `[[#anchor]]` links are intra-page navigation, not graph edges, and
 * are deliberately not recorded.
 *
 * @param db            Open database connection with wiki schema applied
 * @param sourcePageId  wiki_pages.id of the page being updated
 * @param body          Current markdown body text of the page
 */
export function syncWikiLinks(
  db: WasmDb,
  sourcePageId: string,
  body: string,
  /**
   * Wiki root on disk. Optional, but supply it whenever it is known.
   *
   * `wiki_pages` has no aliases column, and aliases are the tier most
   * cross-references on this wiki actually match on — `[[Clay]]`,
   * `[[Sandra Waters]]`, `[[O3]]`. Without the root, those links resolve
   * correctly in the file-based lint and NOT in `wiki_links`, so the two
   * disagree about the same link. Passing the root closes that gap by reading
   * each page's frontmatter from disk.
   */
  wikiRoot?: string,
): void {
  const links = parseWikilinks(body);

  // Delete all existing links from this source page
  db.exec(`DELETE FROM wiki_links WHERE source_page_id = '${escSql(sourcePageId)}'`);

  if (links.length === 0) return;

  const pageRows = db.exec({
    sql: 'SELECT id, path, title FROM wiki_pages',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ id: string; path: string; title: string }>;

  // wiki_pages stores no headings, so cross-page `#anchor` targets resolve to
  // the page and the anchor itself is not verified here. Resolving the page is
  // what the link graph needs; anchor verification belongs to the lint path,
  // which reads page bodies.
  const meta: WikiPageMeta[] = [];
  const relToId = new Map<string, string>();
  let sourceRel = '';
  for (const row of pageRows) {
    if (!row.path) continue;
    meta.push({
      rel: row.path,
      title: row.title || row.path,
      aliases: wikiRoot === undefined ? undefined : readAliasesFromDisk(wikiRoot, row.path),
    });
    relToId.set(row.path, row.id);
    if (row.id === sourcePageId) sourceRel = row.path;
  }

  const index = buildResolveIndexFromMeta(meta);

  // Insert one row per unique target.
  // Prepare a fresh statement for each row — CompatStatement does not support
  // re-binding and re-stepping a DML statement after the first execution.
  const seen = new Set<string>();
  for (const link of links) {
    if (link.target.length === 0) continue; // same-page anchor
    if (seen.has(link.target)) continue;
    seen.add(link.target);

    const res = resolveWikilink(index, sourceRel, link);
    // A page naming itself is not an edge. Recording it would inflate inbound
    // counts and let a page rescue itself from the orphan list.
    if (res.targetRel !== null && res.targetRel === sourceRel) continue;
    // `anchor-missing` still identifies a real target page, so it is recorded
    // as a resolved edge; the stale heading is a lint finding, not a reason to
    // lose the edge.
    const resolvedId = res.targetRel === null ? null : (relToId.get(res.targetRel) ?? null);

    const stmt = db.prepare(
      'INSERT INTO wiki_links (source_page_id, target_title, target_page_id, resolved) VALUES (?, ?, ?, ?)',
    );
    stmt.bind([sourcePageId, link.target, resolvedId, resolvedId !== null ? 1 : 0]);
    stmt.step();
    stmt.finalize();
  }
}

/** What a dangling-link sweep found and changed. */
export interface DanglingLinkResolution {
  /** Rows with `resolved = 0` that were examined. */
  checked: number;
  /** Rows that now resolve and were flipped to `resolved = 1`. */
  resolved: number;
  /** `source_page` → `target_title` for each row that flipped. Ordered. */
  repaired: Array<{ sourcePath: string; targetTitle: string; targetPath: string }>;
}

/**
 * Re-resolve every currently-dangling `wiki_links` row against the wiki as it
 * stands now, and mark the ones that have since acquired a target.
 *
 * WHY THIS EXISTS, AND WHY IT REPLACED A TITLE-ONLY UPDATE (2026-08-14)
 * --------------------------------------------------------------------
 * `syncWikiLinks` only ever rewrites rows whose SOURCE page was re-indexed.
 * Creating a page therefore fixes nothing by itself: every page that already
 * linked to the new one keeps `resolved = 0` until that OTHER page happens to
 * change for some unrelated reason. Live instance: creating `companies/itron.md`
 * left `people/lauren-gilmore.md`'s `[[Itron]]` row unresolved. A full
 * `link-rebuild` hides this — it truncates and recomputes everything — but the
 * incremental path is what actually runs every 15 minutes, so between rebuilds
 * the graph drifts in exactly one direction: it under-reports inbound edges to
 * new pages. Since the link graph is the fan-out index the pipeline uses to
 * decide which other pages a changed fact must touch, an under-reported inbound
 * edge is a page that silently stops receiving corrections.
 *
 * The predecessor of this function was
 * `resolveLinksToPage(db, pageTitle, pageId)`, a single UPDATE matching
 * `LOWER(target_title) = LOWER(pageTitle)`. Two problems, one fatal:
 *
 *   1. Nothing called it. It had been dead since it was written.
 *   2. Title equality is one of the resolver's SIX tiers. A dangling
 *      `[[people/karthik]]` (path), `[[Karthik.md]]` (extension),
 *      `[[Taylor Angevine]]` (display name against a kebab-case stem) or
 *      `[[Clay]]` (frontmatter alias) all fail that comparison. Wiring the old
 *      version up would have repaired the narrowest tier and left the graph
 *      looking maintained — which is worse than leaving it obviously dead,
 *      because the four tiers it misses are the ones that carry most of this
 *      wiki's cross-references.
 *
 * So resolution goes through `resolveWikilink`, the same canonical resolver
 * every reader uses. There is exactly one answer to "does this link resolve".
 *
 * SCOPE. This only ever flips `resolved = 0` → `1`. The converse — a new page
 * making a previously-unique stem or title AMBIGUOUS, which should demote an
 * existing resolved row — is deliberately not handled here, because that row's
 * target is still a real page and silently detaching it would lose an edge the
 * fan-out needs. Ambiguity is reported as a lint/integrity finding for a human
 * to name a winner, which is the rule the whole resolver is built on.
 *
 * @param db        Open database connection with wiki schema applied
 * @param wikiRoot  Wiki root on disk. Supply it whenever known: `wiki_pages`
 *                  has no aliases column, and the alias tier is the one most
 *                  cross-references on this wiki match on.
 */
export function resolveLinksToPage(db: WasmDb, wikiRoot?: string): DanglingLinkResolution {
  const dangling = (db.exec({
    sql: `SELECT l.id AS id, l.target_title AS target_title, l.source_page_id AS source_page_id,
                 p.path AS source_path
            FROM wiki_links l
            JOIN wiki_pages p ON p.id = l.source_page_id
           WHERE l.resolved = 0
           ORDER BY p.path, l.target_title`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ id: number; target_title: string; source_page_id: string; source_path: string }> | void) ?? [];

  const result: DanglingLinkResolution = { checked: dangling.length, resolved: 0, repaired: [] };
  if (dangling.length === 0) return result;

  const pageRows = (db.exec({
    sql: 'SELECT id, path, title FROM wiki_pages',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ id: string; path: string; title: string }> | void) ?? [];

  const meta: WikiPageMeta[] = [];
  const relToId = new Map<string, string>();
  for (const row of pageRows) {
    if (!row.path) continue;
    meta.push({
      rel: row.path,
      title: row.title || row.path,
      aliases: wikiRoot === undefined ? undefined : readAliasesFromDisk(wikiRoot, row.path),
    });
    relToId.set(row.path, row.id);
  }
  const index = buildResolveIndexFromMeta(meta);

  for (const row of dangling) {
    // `target_title` is what syncWikiLinks stored: the parsed link TARGET, with
    // any `#anchor` and `|alias` already split off. Rebuild the minimal shape
    // the resolver takes rather than re-parsing brackets that are not there.
    const res = resolveWikilink(index, row.source_path, {
      raw: row.target_title,
      target: row.target_title,
      anchor: null,
      alias: null,
      line: 0,
    });
    if (res.targetRel === null) continue;
    if (res.targetRel === row.source_path) continue; // a page naming itself is not an edge
    const targetId = relToId.get(res.targetRel);
    if (targetId === undefined) continue;

    const stmt = db.prepare(
      'UPDATE wiki_links SET target_page_id = ?, resolved = 1 WHERE id = ?',
    );
    stmt.bind([targetId, row.id]);
    stmt.step();
    stmt.finalize();

    result.resolved++;
    result.repaired.push({
      sourcePath: row.source_path,
      targetTitle: row.target_title,
      targetPath: res.targetRel,
    });
  }

  return result;
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
