/**
 * wiki-integrity.ts — one machine-readable answer about the wiki's structural
 * health, and the thresholds that make a regression loud.
 *
 * WHY THIS EXISTS
 * ---------------
 * As of 2026-08-14 the numbers were clean — 1 unresolved link, 0 ambiguous, 0
 * frontmatter issues, index and disk agreeing at 320 pages, chunk/contextual
 * gap 0 — and *nothing noticed if they regressed*. Three separate surfaces each
 * saw a slice: the coverage gate is green/red on index drift only,
 * `plumb wiki dream-lint` prints a human report and exits 0 no matter what it
 * finds, and the weekly report counted pages. None of them could answer "is the
 * wiki structurally worse than it was yesterday", because none of them wrote a
 * number down anywhere a later run could compare against.
 *
 * That is the same shape as the two outages this codebase has already paid for.
 * 2026-08-12: `wiki_pages` held 301 rows against 326 on disk for three days,
 * invisible because the only standing monitor was a service liveness probe.
 * 2026-08-08: chunks and contextual embeddings diverged and search silently
 * degraded. Both were *measurable at any moment* and neither was *measured*.
 *
 * So this module computes every deterministic structural fact in one pass and
 * serializes it to `integrity.json`. It is deliberately the ONLY producer of
 * that file, so "the wiki's health" has one definition rather than three that
 * disagree — the same principle that motivated the canonical resolver (see the
 * header of `wiki-resolve.ts`, where three link detectors reported 96, 329 and
 * a third number for the same wiki).
 *
 * WHY THRESHOLDS AND NOT JUST NUMBERS
 * -----------------------------------
 * A number nobody compares is a number nobody reads. The thresholds below are
 * calibrated to the real values measured on 2026-08-14, not invented: the two
 * classes that are at zero today (ambiguous targets, frontmatter issues) are
 * pinned at zero because they were driven there by hand that day and any
 * reappearance is a real regression, while unresolved links get headroom
 * because the wiki legitimately carries forward references to pages that do not
 * exist yet (`[[Plumb Wiki Integrity]]` is one, written on purpose).
 *
 * Nothing here writes to the wiki or the index. Read-only end to end.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';

import { listWikiPages, parseFrontmatter, extractTitle } from './wiki-fs.js';
import { WikiStore } from './wiki-schema.js';
import { checkWikiCoverage, type WikiCoverageReport } from './wiki-coverage.js';
import { analyzeLinks, type LinkFinding, type WikiPageInput } from './wiki-resolve.js';

// ---------------------------------------------------------------------------
// Corpus enumeration, shared with the linter
// ---------------------------------------------------------------------------

/** Required frontmatter fields per SCHEMA.md §2. */
export const REQUIRED_FRONTMATTER_FIELDS: ReadonlyArray<string> = [
  'type',
  'created',
  'updated',
  'source_refs',
  'tags',
  'confidence',
];

/**
 * Generated pages. Their links are derivative, so they neither earn inbound
 * credit nor raise findings — `index.md` links to nearly the whole wiki, and
 * counting it would make the orphan check meaningless, while `log.md` alone
 * carries hundreds of links to pages that were renamed or never existed.
 */
export function isGeneratedWikiPage(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? relPath;
  return (
    base === 'index.md' ||
    base === '_index.md' ||
    base === 'log.md' ||
    base === 'REVIEW.md' ||
    base === 'SCHEMA.md' ||
    base.startsWith('AUDIT_') ||
    base.startsWith('EVAL_') ||
    base.startsWith('REPORT_')
  );
}

export interface WikiCorpusPage {
  readonly rel: string;
  readonly title: string;
  /** Required frontmatter fields this page does not supply. */
  readonly missingFrontmatter: readonly string[];
}

/**
 * Top-level keys actually WRITTEN in a page's frontmatter block.
 *
 * WHY THIS IS NOT `Object.keys(parseFrontmatter(raw).frontmatter)` — a real bug
 * found on 2026-08-14 while building the integrity thresholds.
 *
 * `parseFrontmatter` is a CONSUMER's parser: it normalizes, so a page with no
 * `confidence:` line comes back as `confidence: 'medium'`, and pages with no
 * `tags:` or `source_refs:` come back as `[]`. That is correct for anything
 * reading a page and fatal for anything linting one. Measured: of the six
 * required fields, checking the parsed object can only ever detect `type`,
 * `created` and `updated` — `source_refs`, `tags` and `confidence` are filled in
 * before the check can see they were absent.
 *
 * This is inherited, not new. `plumb wiki dream-lint` has been reporting
 * frontmatter issues off the normalized object since it was written, which is
 * one concrete reason it reported 0 frontmatter issues on the live wiki while
 * the nightly dream's independent PyYAML-parity linter reported 4 on the same
 * files. A linter must read what the author wrote, so this reads the raw block.
 *
 * Deliberately a key scan rather than a second YAML parser: the question is only
 * "is this key present at the top level of the block", and a tolerant scan
 * cannot throw partway through a whole-wiki pass the way a strict parse can.
 */
export function frontmatterKeysPresent(raw: string): Set<string> {
  const keys = new Set<string>();
  const lines = raw.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return keys;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === '---' || line.trim() === '...') break;
    // Top level only: an indented `key:` belongs to a nested mapping.
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (m && m[1] !== undefined) keys.add(m[1]);
  }
  return keys;
}

export interface WikiCorpus {
  /** Every markdown file, generated ones included, as link sources AND targets. */
  readonly corpus: readonly WikiPageInput[];
  /** Generated pages: excluded from orphan results and from inbound credit. */
  readonly generated: readonly string[];
  /** Real hand-written content the indexer skips; never orphan candidates. */
  readonly orphanExempt: readonly string[];
  /** Schema-bearing content pages — the only ones frontmatter is linted on. */
  readonly pages: readonly WikiCorpusPage[];
}

/**
 * Enumerate every markdown file under the wiki root, `archive/` aside.
 *
 * `listWikiPages()` deliberately hides generated and `.plumbignore`d pages.
 * That is right for the indexer and wrong for a link checker: a page the scan
 * cannot see cannot be a link TARGET either, so every reference to one looks
 * broken. They are enumerated here and then CLASSIFIED, rather than being
 * invisible — which is the bug that produced a permanent, unfixable finding for
 * every raw transcript before 2026-08-14.
 *
 * EXTRACTED TO CORE 2026-08-14. This lived privately inside
 * `packages/cli/src/commands/wiki-lint.ts`. Copying it here for the integrity
 * report would have created a second enumeration that could drift from the
 * first — which is exactly how this wiki ended up with three link detectors
 * disagreeing about the same 320 files. One enumeration, two consumers.
 */
export async function collectWikiCorpus(wikiRoot: string): Promise<WikiCorpus> {
  const allPaths: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === '.obsidian' || entry.name === 'archive') continue;
        await walk(join(dir, entry.name), rel);
      } else if (entry.name.endsWith('.md')) {
        allPaths.push(rel);
      }
    }
  };
  await walk(wikiRoot, '');
  allPaths.sort();

  const indexed = new Set(await listWikiPages(wikiRoot));

  const corpus: WikiPageInput[] = [];
  const generated: string[] = [];
  const orphanExempt: string[] = [];
  const pages: WikiCorpusPage[] = [];

  for (const rel of allPaths) {
    let raw: string;
    try {
      raw = readFileSync(join(wikiRoot, rel), 'utf8');
    } catch {
      continue;
    }

    let frontmatter: Record<string, unknown> = {};
    let body = '';
    try {
      const parsed = parseFrontmatter(raw);
      frontmatter = parsed.frontmatter as unknown as Record<string, unknown>;
      body = parsed.body;
    } catch {
      // Unparseable frontmatter counts every required field as missing, rather
      // than throwing and taking the whole scan out over one bad page.
      frontmatter = {};
      body = raw;
    }

    // The resolver reads `aliases:` out of the raw frontmatter itself, so the
    // corpus carries the whole file rather than the parsed body.
    corpus.push({ rel, text: raw });

    if (isGeneratedWikiPage(rel)) {
      generated.push(rel);
      continue;
    }
    if (!indexed.has(rel)) {
      // Real hand-written content the indexer skips (`.plumbignore`, e.g. raw
      // transcripts). Its links still count as edges, but nothing is expected
      // to link TO it, and it carries no `type`/`tags`/`confidence` and never
      // should — frontmatter-linting it produces a permanent, unfixable finding.
      orphanExempt.push(rel);
      continue;
    }

    // Presence comes from the RAW block (the parser defaults three of the six
    // required fields — see `frontmatterKeysPresent`); shape comes from the
    // parsed object, which is the only thing that can say whether a key that IS
    // present holds a list rather than a bare string.
    const present = frontmatterKeysPresent(raw);
    const missingFrontmatter = REQUIRED_FRONTMATTER_FIELDS.filter((field) => {
      if (!present.has(field)) return true;
      const val = frontmatter[field];
      if (val === undefined || val === null || val === '') return true;
      if (field === 'source_refs' || field === 'tags') return !Array.isArray(val);
      return false;
    });

    pages.push({
      rel,
      title: extractTitle(body) ?? rel.replace(/\.md$/, ''),
      missingFrontmatter,
    });
  }

  return { corpus, generated, orphanExempt, pages };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface IntegrityBreach {
  /** Stable machine key, e.g. `links.unresolved`. */
  readonly check: string;
  readonly observed: number | string;
  readonly threshold: number | string;
  /** One sentence a human can act on without opening the code. */
  readonly message: string;
}

export interface WikiIntegrityReport {
  readonly generatedAt: string;
  readonly wikiRoot: string;
  readonly dbPath: string;
  /**
   * Link defects from the canonical resolver, split by REMEDY rather than
   * piled into one "broken" bucket: a missing page is a page to create, an
   * ambiguous name is a human decision, a stale `#anchor` is a one-line edit.
   * Conflating them is what made the old 96-finding report unactionable.
   */
  readonly links: {
    readonly unresolved: number;
    readonly ambiguous: number;
    readonly anchorMissing: number;
    /** Findings dropped because they live on a generated page. Visible, not silent. */
    readonly suppressedOnGeneratedPages: number;
    readonly findings: readonly LinkFinding[];
  };
  readonly orphans: {
    readonly count: number;
    readonly pages: readonly string[];
  };
  readonly frontmatter: {
    readonly count: number;
    readonly issues: ReadonlyArray<{ page: string; missing: readonly string[] }>;
  };
  /** Index-vs-disk agreement, from the coverage gate. */
  readonly index: {
    readonly diskCount: number;
    readonly indexedCount: number;
    readonly missing: readonly string[];
    readonly ghostsDeleted: readonly string[];
    readonly ghostsExcluded: readonly string[];
    readonly stale: readonly string[];
    readonly chunkCount: number;
    readonly contextualCount: number;
    readonly embeddingGap: number;
    readonly ok: boolean;
  };
  /**
   * The `wiki_links` table as it actually stands — the graph
   * `plumb_wiki_links` serves and the fan-out reads. Reported separately from
   * `links` above because the two CAN disagree, and when they do that is
   * itself the finding: the file scan sees `.plumbignore`d pages and the
   * `wiki_pages`-backed graph cannot.
   */
  readonly linkGraph: {
    readonly rows: number;
    readonly resolved: number;
    readonly unresolved: number;
    readonly pagesWithOutbound: number;
  };
  readonly breaches: readonly IntegrityBreach[];
  /** True when no threshold is breached. The exit-code contract. */
  readonly ok: boolean;
}

/**
 * Thresholds, tuned to the values actually measured on 2026-08-14 rather than
 * to round numbers.
 *
 * `maxUnresolvedLinks: 5` — the live count was 1, a deliberate forward
 * reference (`[[Plumb Wiki Integrity]]`, naming a job that does not exist yet).
 * Headroom exists because writing a link before its page is a legitimate way to
 * work here; five is well under the 35 that accumulated while the old detector
 * was too noisy to act on.
 *
 * `maxAmbiguous: 0` and `maxFrontmatterIssues: 0` — both were driven to zero by
 * hand on 2026-08-14 (seven ambiguous names resolved by merging or renaming,
 * three frontmatter issues repaired). They are pinned at zero because each one
 * is individually fixable and because an ambiguous name is uniquely corrosive:
 * a shared name resolves to NEITHER page, so one collision can make two real
 * pages look like orphans.
 *
 * `maxEmbeddingGap: 0` — a nonzero gap is the 2026-08-08 outage signature,
 * where pages stayed findable but ranked on a degraded path. There is no benign
 * value.
 */
export const INTEGRITY_THRESHOLDS = {
  maxUnresolvedLinks: 5,
  maxAmbiguous: 0,
  maxAnchorMissing: 0,
  maxFrontmatterIssues: 0,
  maxEmbeddingGap: 0,
  /** Index and disk must agree exactly; any drift is the 2026-08-12 signature. */
  requireIndexMatchesDisk: true,
} as const;

export function evaluateIntegrity(
  report: Omit<WikiIntegrityReport, 'breaches' | 'ok'>,
  thresholds: typeof INTEGRITY_THRESHOLDS = INTEGRITY_THRESHOLDS,
): IntegrityBreach[] {
  const breaches: IntegrityBreach[] = [];

  if (report.links.unresolved > thresholds.maxUnresolvedLinks) {
    breaches.push({
      check: 'links.unresolved',
      observed: report.links.unresolved,
      threshold: thresholds.maxUnresolvedLinks,
      message:
        `${report.links.unresolved} wikilinks point at pages that do not exist ` +
        `(threshold ${thresholds.maxUnresolvedLinks}). This list IS the page-creation backlog.`,
    });
  }
  if (report.links.ambiguous > thresholds.maxAmbiguous) {
    breaches.push({
      check: 'links.ambiguous',
      observed: report.links.ambiguous,
      threshold: thresholds.maxAmbiguous,
      message:
        `${report.links.ambiguous} wikilinks name something two pages answer to. An ambiguous ` +
        `link credits NEITHER page, so each collision can also manufacture two false orphans. ` +
        `Merge the pages or alias one of them.`,
    });
  }
  if (report.links.anchorMissing > thresholds.maxAnchorMissing) {
    breaches.push({
      check: 'links.anchorMissing',
      observed: report.links.anchorMissing,
      threshold: thresholds.maxAnchorMissing,
      message:
        `${report.links.anchorMissing} wikilinks name a heading that no longer exists on the ` +
        `target page. Usually a heading was renamed; each is a one-line edit.`,
    });
  }
  if (report.frontmatter.count > thresholds.maxFrontmatterIssues) {
    breaches.push({
      check: 'frontmatter.count',
      observed: report.frontmatter.count,
      threshold: thresholds.maxFrontmatterIssues,
      message:
        `${report.frontmatter.count} pages are missing required frontmatter fields. ` +
        `Frontmatter is what the schema and the type-directory checks rest on.`,
    });
  }
  if (report.index.embeddingGap !== thresholds.maxEmbeddingGap) {
    breaches.push({
      check: 'index.embeddingGap',
      observed: report.index.embeddingGap,
      threshold: thresholds.maxEmbeddingGap,
      message:
        `wiki_chunks (${report.index.chunkCount}) and wiki_chunk_context_embeddings ` +
        `(${report.index.contextualCount}) disagree. This is the 2026-08-08 signature: pages ` +
        `stay findable but rank on a degraded path, so search gets quietly worse.`,
    });
  }
  if (thresholds.requireIndexMatchesDisk && report.index.diskCount !== report.index.indexedCount) {
    breaches.push({
      check: 'index.diskCount',
      observed: `${report.index.diskCount} on disk vs ${report.index.indexedCount} indexed`,
      threshold: 'equal',
      message:
        `Index and disk disagree. This is the 2026-08-12 signature, which ran for three days ` +
        `unnoticed (301 indexed against 326 on disk).`,
    });
  }
  if (report.index.missing.length > 0) {
    breaches.push({
      check: 'index.missing',
      observed: report.index.missing.length,
      threshold: 0,
      message:
        `${report.index.missing.length} pages exist on disk with no wiki_pages row: ` +
        `${report.index.missing.slice(0, 5).join(', ')}. They are unsearchable.`,
    });
  }
  if (report.index.stale.length > 0) {
    breaches.push({
      check: 'index.stale',
      observed: report.index.stale.length,
      threshold: 0,
      message:
        `${report.index.stale.length} indexed pages no longer match their stored content hash: ` +
        `${report.index.stale.slice(0, 5).join(', ')}. Search is serving outdated text for them.`,
    });
  }

  return breaches;
}

export interface WikiIntegrityOptions {
  wikiRoot?: string;
  dbPath?: string;
}

/** Compute the whole structural picture in one read-only pass. */
export async function collectWikiIntegrity(
  options: WikiIntegrityOptions = {},
): Promise<WikiIntegrityReport> {
  const wikiRoot = options.wikiRoot ?? join(homedir(), '.plumb', 'wiki');
  const dbPath = options.dbPath ?? join(homedir(), '.plumb', 'wiki.db');

  const { corpus, generated, orphanExempt, pages } = await collectWikiCorpus(wikiRoot);
  const graph = analyzeLinks([...corpus], {
    generatedPages: [...generated],
    orphanExempt: [...orphanExempt],
  });

  const byStatus = { unresolved: 0, ambiguous: 0, 'anchor-missing': 0 };
  for (const f of graph.findings) byStatus[f.status]++;

  const frontmatterIssues = pages
    .filter((p) => p.missingFrontmatter.length > 0)
    .map((p) => ({ page: p.rel, missing: p.missingFrontmatter }));

  const coverage: WikiCoverageReport = await checkWikiCoverage({ wikiRoot, dbPath });

  const store = await WikiStore.create({ dbPath });
  let linkGraph: WikiIntegrityReport['linkGraph'];
  try {
    const db = store.db;
    const rows = Number(db.selectValue('SELECT COUNT(*) FROM wiki_links') ?? 0);
    const resolved = Number(db.selectValue('SELECT COUNT(*) FROM wiki_links WHERE resolved = 1') ?? 0);
    const pagesWithOutbound = Number(
      db.selectValue('SELECT COUNT(DISTINCT source_page_id) FROM wiki_links') ?? 0,
    );
    linkGraph = { rows, resolved, unresolved: rows - resolved, pagesWithOutbound };
  } finally {
    store.close();
  }

  const base = {
    generatedAt: new Date().toISOString(),
    wikiRoot,
    dbPath,
    links: {
      unresolved: byStatus.unresolved,
      ambiguous: byStatus.ambiguous,
      anchorMissing: byStatus['anchor-missing'],
      suppressedOnGeneratedPages: graph.suppressedOnGeneratedPages,
      findings: graph.findings,
    },
    orphans: { count: graph.orphans.length, pages: graph.orphans },
    frontmatter: { count: frontmatterIssues.length, issues: frontmatterIssues },
    index: {
      diskCount: coverage.diskCount,
      indexedCount: coverage.indexedCount,
      missing: coverage.missing,
      ghostsDeleted: coverage.ghostsDeleted,
      ghostsExcluded: coverage.ghostsExcluded,
      stale: coverage.stale,
      chunkCount: coverage.chunkCount,
      contextualCount: coverage.contextualCount,
      embeddingGap: coverage.embeddingGap,
      ok: coverage.ok,
    },
    linkGraph,
  } satisfies Omit<WikiIntegrityReport, 'breaches' | 'ok'>;

  const breaches = evaluateIntegrity(base);
  return { ...base, breaches, ok: breaches.length === 0 };
}

/** Default location of the artifact: `~/.plumb/integrity.json`. */
export function defaultIntegrityPath(dbPath?: string): string {
  const dir = dbPath === undefined ? join(homedir(), '.plumb') : join(dbPath, '..');
  return join(dir, 'integrity.json');
}

/**
 * Write the artifact.
 *
 * Written whole on every run rather than appended, because its job is "what is
 * true right now" and a consumer must never have to reason about which line is
 * current. History lives in the weekly report and in the job logs.
 */
export function writeIntegrityReport(path: string, report: WikiIntegrityReport): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
}

/** Read a previously written artifact, or null when absent/unreadable. */
export function readIntegrityReport(path: string): WikiIntegrityReport | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WikiIntegrityReport;
  } catch {
    return null;
  }
}
