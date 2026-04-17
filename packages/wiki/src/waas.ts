/**
 * waas.ts — Wiki-as-a-Service: the ONLY write path to the Plumb wiki.
 *
 * Exposes a narrow four-method API:
 *   wiki.read(path)         Read a page from disk (parsed frontmatter + body)
 *   wiki.write(patch)       Validate + write + recompute hash + sync links + changelog
 *   wiki.query(opts)        Query wiki pages from wiki.db (or filesystem fallback)
 *   wiki.links(path)        Outbound + inbound links for a page
 *
 * Every wiki.write call:
 *   1. Validates frontmatter against SCHEMA.md §3 (rejects invalid pages)
 *   2. Writes the file to disk via writeWikiPage()
 *   3. Recomputes the SHA-256 content_hash and upserts wiki_pages in wiki.db
 *   4. Rebuilds wiki_links for the page (delete + re-insert)
 *   5. Appends a wiki_changelog entry
 *
 * No direct fs.writeFile on wiki/* anywhere else. This is the gate.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  readWikiPage,
  writeWikiPage,
  listWikiPages,
  hashWikiPage,
  parseFrontmatter,
  extractTitle,
  syncWikiLinks,
  getOutboundLinks,
  getInboundLinks,
  WikiStore,
  hashContent,
  formatPage,
} from '@getplumb/core';
import type { WikiPage, WikiFrontmatter, WikiStoreOptions, WasmDb } from '@getplumb/core';
import { validateFrontmatter } from './frontmatter-validator.js';
import type { ValidationError } from './frontmatter-validator.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Input for wiki.write(). Contains the full page content to write.
 * The frontmatter is validated before any file I/O is performed.
 */
export interface WikiWritePatch {
  /** Relative path from wikiRoot, e.g. "people/dylan-sellberg.md" */
  path: string;
  /** Validated frontmatter fields — type, created, updated, etc. */
  frontmatter: WikiFrontmatter;
  /** Markdown body (should start with H1 title on the first non-blank line) */
  body: string;
  /**
   * Source reference for the changelog entry, e.g. "seed", "dream", "queue:abc123".
   * Optional — defaults to "wiki.write".
   */
  sourceRef?: string;
}

/**
 * Thrown by wiki.write() when frontmatter validation fails.
 * Contains the list of validation errors so callers can log or display them.
 */
export class WikiValidationError extends Error {
  readonly errors: ValidationError[];
  readonly path: string;

  constructor(path: string, errors: ValidationError[]) {
    const summary = errors.map((e) => `  ${e.field}: ${e.message}`).join('\n');
    super(`Wiki write rejected for "${path}" — frontmatter validation failed:\n${summary}`);
    this.name = 'WikiValidationError';
    this.errors = errors;
    this.path = path;
  }
}

/**
 * Options for wiki.query().
 */
export interface WikiQueryOptions {
  type?: string;
  status?: 'active' | 'archived';
  tags?: string[];
  limit?: number;
  offset?: number;
}

/**
 * A row returned by wiki.query() — metadata about a page from wiki.db.
 */
export interface WikiPageRecord {
  id: string;
  path: string;
  type: string;
  title: string;
  created: string;
  updated: string;
  confidence: string;
  tags: string[];
  source_refs: string[];
  status: string;
  word_count: number | null;
  content_hash: string | null;
}

/**
 * Result of wiki.links(path).
 */
export interface WikiLinksResult {
  outbound: Array<{ id: number; target_title: string; target_page_id: string | null; resolved: number }>;
  inbound: Array<{ id: number; source_page_id: string; target_title: string }>;
}

/**
 * Options for constructing a WikiService instance.
 */
export interface WikiServiceOptions {
  /** Absolute path to the wiki root directory. Defaults to ~/.plumb/wiki */
  wikiRoot?: string;
  /** Options for the wiki.db connection. If omitted, DB integration is skipped. */
  db?: WikiStoreOptions;
}

// ---------------------------------------------------------------------------
// WikiService
// ---------------------------------------------------------------------------

/**
 * WikiService — the single gate for all wiki reads and writes.
 *
 * Instantiate with WikiService.create() to get DB integration, or use
 * WikiService.createFilesystemOnly() for tests / read-only scenarios.
 */
export class WikiService {
  readonly wikiRoot: string;
  readonly #store: WikiStore | null;

  private constructor(wikiRoot: string, store: WikiStore | null) {
    this.wikiRoot = wikiRoot;
    this.#store = store;
  }

  // -------------------------------------------------------------------------
  // Factory methods
  // -------------------------------------------------------------------------

  /**
   * Create a WikiService with full DB integration.
   * Opens (or creates) wiki.db at the configured path.
   */
  static async create(options: WikiServiceOptions = {}): Promise<WikiService> {
    const wikiRoot = options.wikiRoot ?? join(homedir(), '.plumb', 'wiki');
    mkdirSync(wikiRoot, { recursive: true });
    const store = await WikiStore.create(options.db);
    return new WikiService(wikiRoot, store);
  }

  /**
   * Create a WikiService with no DB — filesystem operations only.
   * wiki.write() still validates and writes files; DB operations are skipped.
   * wiki.query() falls back to a filesystem scan.
   * wiki.links() falls back to parsing the target file for wikilinks.
   *
   * Use this in tests or contexts where wiki.db is not available.
   */
  static createFilesystemOnly(wikiRoot: string): WikiService {
    return new WikiService(wikiRoot, null);
  }

  /** Close the DB connection if open. No-op for filesystem-only instances. */
  close(): void {
    this.#store?.close();
  }

  // -------------------------------------------------------------------------
  // read(path)
  // -------------------------------------------------------------------------

  /**
   * Read a wiki page from disk. Parses frontmatter and body.
   *
   * @param relPath  Relative path from wikiRoot, e.g. "people/dylan-sellberg.md"
   */
  async read(relPath: string): Promise<WikiPage> {
    return readWikiPage(this.wikiRoot, relPath);
  }

  // -------------------------------------------------------------------------
  // write(patch)
  // -------------------------------------------------------------------------

  /**
   * Validate and write a wiki page.
   *
   * Throws WikiValidationError if frontmatter is invalid (missing required fields,
   * invalid type enum, wrong confidence, bad date format).
   *
   * On success:
   *   - Writes the file to disk (creating parent directories as needed)
   *   - Recomputes content_hash and upserts wiki_pages in wiki.db
   *   - Rebuilds wiki_links for the page
   *   - Appends a wiki_changelog entry
   *
   * @throws WikiValidationError   frontmatter validation failed
   * @throws Error                 unexpected I/O or DB failure
   */
  async write(patch: WikiWritePatch): Promise<{ contentHash: string }> {
    const { path: relPath, frontmatter, body, sourceRef = 'wiki.write' } = patch;

    // 1. Validate frontmatter — no file I/O until this passes.
    const result = validateFrontmatter(frontmatter);
    if (!result.valid) {
      throw new WikiValidationError(relPath, result.errors);
    }

    // 2. Write the file to disk.
    await writeWikiPage(this.wikiRoot, relPath, frontmatter, body);

    // 3. Compute content_hash from the just-written file.
    const contentHash = await hashWikiPage(this.wikiRoot, relPath);

    // 4. DB integration (skipped if no store is configured).
    if (this.#store !== null) {
      const db = this.#store.db;
      const pageId = relPath.replace(/\.md$/, '');
      const title = extractTitle(body) ?? pageId.replace(/^.*\//, '');
      const wordCount = body.trim().split(/\s+/).filter(Boolean).length;

      // Upsert wiki_pages — update content_hash and metadata.
      const stmt = db.prepare(`
        INSERT INTO wiki_pages (id, path, type, title, created, updated, confidence, tags, source_refs, status, word_count, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          path         = excluded.path,
          type         = excluded.type,
          title        = excluded.title,
          updated      = excluded.updated,
          confidence   = excluded.confidence,
          tags         = excluded.tags,
          source_refs  = excluded.source_refs,
          status       = excluded.status,
          word_count   = excluded.word_count,
          content_hash = excluded.content_hash
      `);
      stmt.bind([
        pageId,
        relPath,
        frontmatter.type,
        title,
        frontmatter.created,
        frontmatter.updated,
        frontmatter.confidence,
        JSON.stringify(frontmatter.tags),
        JSON.stringify(frontmatter.source_refs),
        frontmatter.status ?? 'active',
        wordCount,
        contentHash,
      ]);
      stmt.step();
      stmt.finalize();

      // Rebuild wiki_links for this page.
      syncWikiLinks(db, pageId, body);

      // Append wiki_changelog entry.
      const isNew = this.#isNewPage(db, pageId);
      const action = isNew ? 'created' : 'updated';
      const changeStmt = db.prepare(`
        INSERT INTO wiki_changelog (page_id, action, detail, source_ref, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      changeStmt.bind([
        pageId,
        action,
        JSON.stringify({ path: relPath, word_count: wordCount }),
        sourceRef,
        new Date().toISOString(),
      ]);
      changeStmt.step();
      changeStmt.finalize();
    }

    return { contentHash };
  }

  // -------------------------------------------------------------------------
  // query(opts)
  // -------------------------------------------------------------------------

  /**
   * Query wiki pages. When DB is available, queries wiki_pages table.
   * Falls back to a filesystem scan when no DB is configured.
   *
   * @param opts  Filtering options: type, status, tags, limit, offset
   */
  async query(opts: WikiQueryOptions = {}): Promise<WikiPageRecord[]> {
    if (this.#store !== null) {
      return this.#queryDb(opts);
    }
    return this.#queryFilesystem(opts);
  }

  // -------------------------------------------------------------------------
  // links(path)
  // -------------------------------------------------------------------------

  /**
   * Return outbound and inbound links for a page.
   * Requires DB to be configured; throws if called on a filesystem-only instance.
   *
   * @param relPath  Relative path of the page (e.g. "people/dylan-sellberg.md")
   */
  links(relPath: string): WikiLinksResult {
    if (this.#store === null) {
      throw new Error(
        'wiki.links() requires a DB connection. Use WikiService.create() instead of createFilesystemOnly().',
      );
    }
    const db = this.#store.db;
    const pageId = relPath.replace(/\.md$/, '');
    return {
      outbound: getOutboundLinks(db, pageId),
      inbound: getInboundLinks(db, pageId),
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** True if wiki_pages has no row for this pageId (i.e., this is a create). */
  #isNewPage(db: WasmDb, pageId: string): boolean {
    try {
      const rows = db.exec({
        sql: `SELECT id FROM wiki_pages WHERE id = '${pageId.replace(/'/g, "''")}'`,
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as Array<{ id: string }>;
      return rows.length === 0;
    } catch {
      return true;
    }
  }

  /** Query wiki_pages from the DB with optional filters. */
  #queryDb(opts: WikiQueryOptions): WikiPageRecord[] {
    const db = this.#store!.db;
    const conditions: string[] = ["status != 'archived' OR status = 'archived'"];

    if (opts.type) {
      conditions.push(`type = '${opts.type.replace(/'/g, "''")}'`);
    }
    if (opts.status) {
      conditions.push(`status = '${opts.status.replace(/'/g, "''")}'`);
    } else {
      conditions.push(`status = 'active'`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit !== undefined ? `LIMIT ${opts.limit}` : '';
    const offset = opts.offset !== undefined ? `OFFSET ${opts.offset}` : '';

    const sql = `SELECT * FROM wiki_pages ${where} ORDER BY updated DESC ${limit} ${offset}`;

    const rows = db.exec({
      sql,
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{
      id: string;
      path: string;
      type: string;
      title: string;
      created: string;
      updated: string;
      confidence: string;
      tags: string | null;
      source_refs: string | null;
      status: string;
      word_count: number | null;
      content_hash: string | null;
    }>;

    return rows.map((row) => ({
      ...row,
      tags: tryParseJson<string[]>(row.tags, []),
      source_refs: tryParseJson<string[]>(row.source_refs, []),
    }));
  }

  /** Filesystem fallback for query() when no DB is configured. */
  async #queryFilesystem(opts: WikiQueryOptions): Promise<WikiPageRecord[]> {
    const relPaths = await listWikiPages(this.wikiRoot, {
      includeArchive: opts.status === 'archived',
    });

    const results: WikiPageRecord[] = [];

    for (const relPath of relPaths) {
      try {
        const page = await readWikiPage(this.wikiRoot, relPath);
        const fm = page.frontmatter;

        if (opts.type && fm.type !== opts.type) continue;
        if (opts.status && (fm.status ?? 'active') !== opts.status) continue;
        if (!opts.status && (fm.status ?? 'active') !== 'active') continue;
        if (opts.tags && opts.tags.length > 0) {
          const pageTags = fm.tags ?? [];
          const hasAllTags = opts.tags.every((t) => pageTags.includes(t));
          if (!hasAllTags) continue;
        }

        const pageId = relPath.replace(/\.md$/, '');
        const wordCount = page.body.trim().split(/\s+/).filter(Boolean).length;

        results.push({
          id: pageId,
          path: relPath,
          type: fm.type,
          title: page.title ?? pageId.replace(/^.*\//, ''),
          created: fm.created,
          updated: fm.updated,
          confidence: fm.confidence,
          tags: fm.tags ?? [],
          source_refs: fm.source_refs ?? [],
          status: fm.status ?? 'active',
          word_count: wordCount,
          content_hash: null,
        });
      } catch {
        // Skip unreadable pages
      }
    }

    // Sort by updated desc
    results.sort((a, b) => b.updated.localeCompare(a.updated));

    if (opts.offset !== undefined) {
      results.splice(0, opts.offset);
    }
    if (opts.limit !== undefined) {
      results.splice(opts.limit);
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryParseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
