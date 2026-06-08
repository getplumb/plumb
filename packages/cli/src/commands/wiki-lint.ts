/**
 * wiki-lint.ts — Lint phase of the nightly dream cron (T-239).
 *
 * Checks for:
 *   1. Orphan pages — pages with no inbound links from any other wiki page
 *   2. Broken wikilinks — [[Link]] targets that don't resolve to a file on disk
 *   3. Frontmatter inconsistencies — missing required fields
 *   4. Dead-letter queue items — facts that failed 3× and need human attention
 *
 * Appends a Lint Report section to log.md.
 * Does NOT auto-fix — lint is report-only.
 * Exits 0 even when issues found.
 *
 * Usage:
 *   plumb wiki dream-lint [--wiki <path>] [--sessions <path>]
 *                         [--dead-letter <path>] [--date <YYYY-MM-DD>] [--dry-run]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { listWikiPages, parseFrontmatter, extractTitle } from '@getplumb/core';
import { extractWikilinks } from '@getplumb/core';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Required frontmatter fields per SCHEMA.md */
const REQUIRED_FRONTMATTER_FIELDS: ReadonlyArray<string> = [
  'type',
  'created',
  'updated',
  'source_refs',
  'tags',
  'confidence',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiLintOptions {
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** OpenClaw sessions directory. Defaults to ~/.openclaw/agents/main/sessions */
  sessions?: string;
  /** Path to dead-letter queue file. Defaults to ~/.plumb/wiki-queue-dead.jsonl */
  deadLetter?: string;
  /** Date string YYYY-MM-DD. Defaults to today */
  date?: string;
  /** If true, print report but do not write to log.md */
  dryRun?: boolean;
}

interface OrphanPage {
  /** Wiki-relative path */
  path: string;
}

interface BrokenLink {
  /** Source page containing the broken wikilink */
  sourcePath: string;
  /** The wikilink target that could not be resolved */
  target: string;
}

interface FrontmatterIssue {
  /** Wiki-relative path */
  path: string;
  /** List of missing field names */
  missingFields: string[];
}

interface DeadLetterItem {
  id: string;
  fact: string;
  dead_lettered_at: string;
  final_error: string;
  retry_count: number;
}

interface LintReport {
  orphanPages: OrphanPage[];
  brokenLinks: BrokenLink[];
  frontmatterIssues: FrontmatterIssue[];
  deadLetterItems: DeadLetterItem[];
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function nowHHMM(): string {
  return new Date().toTimeString().slice(0, 5);
}

// ---------------------------------------------------------------------------
// Title-to-path index
// ---------------------------------------------------------------------------

interface PageInfo {
  relPath: string;
  title: string;
  aliases: string[];
  updated: string;
  frontmatterMissing: string[];
}

/**
 * Scan all wiki pages, parse frontmatter + title, extract wikilinks.
 * Returns page info array and the full link map (sourcePath → link targets).
 */
/**
 * Convert a wikilink target to a filesystem-style slug:
 * lowercase, alphanumerics + dashes only, spaces → dashes, collapse repeats.
 * Used as a fallback resolver when a [[Target]] doesn't match any H1 title
 * but does match a page basename (e.g. [[claude-code]] → tools/claude-code.md).
 */
function slugifyLinkTarget(target: string): string {
  return target
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function buildPageIndex(wikiRoot: string): Promise<{
  pages: PageInfo[];
  linkMap: Map<string, string[]>;
  titleToPath: Map<string, string>;
  slugToPath: Map<string, string>;
}> {
  const relPaths = await listWikiPages(wikiRoot);
  const pages: PageInfo[] = [];
  const linkMap = new Map<string, string[]>();
  const titleToPath = new Map<string, string>();
  const slugToPath = new Map<string, string>();

  for (const relPath of relPaths) {
    const absPath = join(wikiRoot, relPath);
    let raw: string;
    try {
      raw = readFileSync(absPath, 'utf8');
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
      // Can't parse frontmatter — record all required fields as missing
      frontmatter = {};
      body = raw;
    }

    const title = extractTitle(body) ?? relPath.replace(/\.md$/, '');
    const updated = String(frontmatter['updated'] ?? '');

    // Check for missing required frontmatter fields
    const missingFields = REQUIRED_FRONTMATTER_FIELDS.filter((field) => {
      const val = frontmatter[field];
      if (val === undefined || val === null || val === '') return true;
      // source_refs and tags must be arrays (not empty strings)
      if (field === 'source_refs' || field === 'tags') {
        return !Array.isArray(val);
      }
      return false;
    });

    const aliasesRaw = frontmatter['aliases'];
    const aliases = Array.isArray(aliasesRaw)
      ? aliasesRaw.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
      : [];

    pages.push({ relPath, title, aliases, updated, frontmatterMissing: missingFields });
    titleToPath.set(title.toLowerCase(), relPath);

    // Also index by basename slug for lowercase/hyphenated wikilinks
    const baseSlug = relPath.replace(/^.*\//, '').replace(/\.md$/, '').toLowerCase();
    slugToPath.set(baseSlug, relPath);

    // Index any aliases declared in frontmatter (aliases: [Clay, Clay W])
    if (aliases.length > 0) {
      for (const alias of aliases) {
        titleToPath.set(alias.toLowerCase(), relPath);
      }
    }

    // Extract wikilinks from body
    const links = extractWikilinks(body);
    linkMap.set(relPath, links);
  }

  return { pages, linkMap, titleToPath, slugToPath };
}

// ---------------------------------------------------------------------------
// Lint checks
// ---------------------------------------------------------------------------

/**
 * Check 1: Semantic orphan pages — pages that no other content page links to.
 * A page is NOT an orphan if its title, alias, or basename slug appears as a
 * wikilink target in any other indexed wiki page.
 */
function detectOrphans(pages: PageInfo[], linkMap: Map<string, string[]>): OrphanPage[] {
  // Build the set of all link targets (lowercased titles AND their slugified forms)
  const linkedTitles = new Set<string>();
  const linkedSlugs = new Set<string>();
  for (const targets of linkMap.values()) {
    for (const t of targets) {
      const name = t.split('|')[0] ?? t;
      linkedTitles.add(name.toLowerCase());
      const slug = slugifyLinkTarget(name);
      if (slug) linkedSlugs.add(slug);
    }
  }

  const orphans: OrphanPage[] = [];
  for (const page of pages) {
    const possibleTargets = [page.title, ...page.aliases].map((name) => name.toLowerCase());
    const baseSlug = page.relPath.replace(/^.*\//, '').replace(/\.md$/, '').toLowerCase();
    if (possibleTargets.some((target) => linkedTitles.has(target))) continue;
    if (possibleTargets.some((target) => {
      const slug = slugifyLinkTarget(target);
      return slug.length > 0 && linkedSlugs.has(slug);
    })) continue;
    if (linkedSlugs.has(baseSlug)) continue;
    orphans.push({ path: page.relPath });
  }

  return orphans;
}

/**
 * Check 2: Broken wikilinks — [[Target]] targets that don't resolve to any page.
 * Checks against (1) the title-to-path map (case-insensitive) and
 * (2) a basename-slug fallback so [[claude-code]] resolves to tools/claude-code.md.
 */
function detectBrokenLinks(
  linkMap: Map<string, string[]>,
  titleToPath: Map<string, string>,
  slugToPath: Map<string, string>,
): BrokenLink[] {
  const broken: BrokenLink[] = [];

  for (const [sourcePath, targets] of linkMap.entries()) {
    for (const target of targets) {
      // Strip alias: [[Name|display]] → use the part before the pipe
      const targetName = target.split('|')[0] ?? target;
      const lowerTitle = targetName.toLowerCase();
      if (titleToPath.has(lowerTitle)) continue;
      const slug = slugifyLinkTarget(targetName);
      if (slug && slugToPath.has(slug)) continue;
      broken.push({ sourcePath, target });
    }
  }

  return broken;
}

/**
 * Check 3: Frontmatter inconsistencies — missing required fields.
 */
function detectFrontmatterIssues(pages: PageInfo[]): FrontmatterIssue[] {
  return pages
    .filter((p) => p.frontmatterMissing.length > 0)
    .map((p) => ({ path: p.relPath, missingFields: p.frontmatterMissing }));
}

/**
 * Check 4: Dead-letter queue items — facts that failed 3× and need human attention.
 * Reads ~/.plumb/wiki-queue-dead.jsonl directly (no wiki-worker import needed).
 */
async function readDeadLetterItems(deadLetterPath: string): Promise<DeadLetterItem[]> {
  if (!existsSync(deadLetterPath)) return [];
  try {
    const raw = readFileSync(deadLetterPath, 'utf8');
    const items: DeadLetterItem[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        items.push(JSON.parse(trimmed) as DeadLetterItem);
      } catch {
        // skip malformed lines
      }
    }
    return items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function formatReport(
  report: LintReport,
  today: string,
  timeStr: string,
): string {
  const totalIssues =
    report.orphanPages.length +
    report.brokenLinks.length +
    report.frontmatterIssues.length +
    report.deadLetterItems.length;

  const lines: string[] = [
    `\n## ${today}\n`,
    `### Lint Report (${timeStr} MT)`,
    '',
  ];

  // Orphan pages
  lines.push(`**Semantic orphan pages** (no inbound wikilinks from content pages; generated indexes/logs excluded): ${report.orphanPages.length}`);
  if (report.orphanPages.length > 0) {
    for (const p of report.orphanPages) {
      lines.push(`- ${p.path}`);
    }
  }
  lines.push('');

  // Broken wikilinks
  lines.push(`**Broken wikilinks** (target not found): ${report.brokenLinks.length}`);
  if (report.brokenLinks.length > 0) {
    for (const b of report.brokenLinks) {
      lines.push(`- ${b.sourcePath} → [[${b.target}]]`);
    }
  }
  lines.push('');

  // Frontmatter issues
  lines.push(`**Frontmatter issues**: ${report.frontmatterIssues.length}`);
  if (report.frontmatterIssues.length > 0) {
    for (const f of report.frontmatterIssues) {
      lines.push(`- ${f.path}: missing fields: ${f.missingFields.join(', ')}`);
    }
  }
  lines.push('');

  // Dead-letter queue items
  lines.push(`**Dead-letter queue** (failed 3×, need human review): ${report.deadLetterItems.length}`);
  if (report.deadLetterItems.length > 0) {
    for (const d of report.deadLetterItems) {
      const ts = d.dead_lettered_at.slice(0, 10);
      lines.push(`- [${ts}] ${d.fact.slice(0, 80)}${d.fact.length > 80 ? '…' : ''}`);
      lines.push(`  Error: ${d.final_error.slice(0, 100)}`);
    }
  }
  lines.push('');

  lines.push(`Total issues: ${totalIssues}`);

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// log.md appending
// ---------------------------------------------------------------------------

async function appendToLog(
  wikiRoot: string,
  entry: string,
  dryRun: boolean,
): Promise<void> {
  const logPath = join(wikiRoot, 'log.md');

  if (dryRun) {
    console.log('\n[dry-run] Would append to log.md:');
    console.log(entry);
    return;
  }

  if (!existsSync(logPath)) {
    writeFileSync(
      logPath,
      '# Wiki Activity Log\n\nAppend-only. New entries go at the top (newest first). Never edit or delete past entries.\n\n---\n',
      'utf8',
    );
  }

  try {
    const existing = readFileSync(logPath, 'utf8');
    const separatorIdx = existing.indexOf('\n---\n');
    if (separatorIdx !== -1) {
      const before = existing.slice(0, separatorIdx + 5);
      const after = existing.slice(separatorIdx + 5);
      writeFileSync(logPath, before + entry + after, 'utf8');
    } else {
      await appendFile(logPath, entry, 'utf8');
    }
  } catch {
    await appendFile(logPath, entry, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function wikiLintCommand(options: WikiLintOptions = {}): Promise<void> {
  const today = options.date ?? new Date().toISOString().slice(0, 10);
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');
  const deadLetterPath =
    options.deadLetter ?? join(homedir(), '.plumb', 'wiki-queue-dead.jsonl');
  const dryRun = options.dryRun ?? false;
  const timeStr = nowHHMM();

  console.log(`Wiki lint — ${today}`);
  console.log(`  wiki:     ${wikiRoot}`);
  if (dryRun) console.log(`  [dry-run mode]`);

  if (!existsSync(wikiRoot)) {
    console.log('\nWiki root not found — nothing to lint.');
    return;
  }

  // --- Build page index ---
  console.log('\nScanning wiki pages…');
  const { pages, linkMap, titleToPath, slugToPath } = await buildPageIndex(wikiRoot);
  console.log(`  Found ${pages.length} page(s).`);

  if (pages.length === 0) {
    console.log('No pages to lint.');
    return;
  }

  // --- Run lint checks ---
  console.log('\nRunning lint checks…');

  const orphanPages = detectOrphans(pages, linkMap);
  console.log(`  Orphan pages:       ${orphanPages.length}`);

  const brokenLinks = detectBrokenLinks(linkMap, titleToPath, slugToPath);
  console.log(`  Broken wikilinks:   ${brokenLinks.length}`);

  const frontmatterIssues = detectFrontmatterIssues(pages);
  console.log(`  Frontmatter issues: ${frontmatterIssues.length}`);

  const deadLetterItems = await readDeadLetterItems(deadLetterPath);
  console.log(`  Dead-letter items:  ${deadLetterItems.length}`);

  const report: LintReport = {
    orphanPages,
    brokenLinks,
    frontmatterIssues,
    deadLetterItems,
  };
  const totalIssues =
    orphanPages.length +
    brokenLinks.length +
    frontmatterIssues.length +
    deadLetterItems.length;

  // --- Format and display report ---
  const entry = formatReport(report, today, timeStr);
  console.log('\n' + entry);

  // --- Append to log.md ---
  await appendToLog(wikiRoot, entry, dryRun);
  if (!dryRun) {
    console.log('Lint report appended to log.md.');
  }

  console.log(`\nLint complete. Total issues: ${totalIssues}`);
  // Always exit 0 — lint is report-only, not an error condition
}
