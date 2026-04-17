/**
 * wiki-lint.ts — Lint phase of the nightly dream cron (spec §5.2, step 5).
 *
 * Checks for:
 *   1. Orphan pages — pages with no inbound links from any other wiki page
 *   2. Broken wikilinks — [[Link]] targets that don't resolve to a file on disk
 *   3. Stale pages — pages with updated_at >30 days ago referenced in today's chat
 *   4. Frontmatter inconsistencies — missing required fields
 *
 * Appends a Lint Report section to log.md.
 * Does NOT auto-fix — lint is report-only.
 * Exits 0 even when issues found.
 *
 * Usage:
 *   plumb wiki dream-lint [--wiki <path>] [--sessions <path>]
 *                         [--date <YYYY-MM-DD>] [--dry-run]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync, statSync } from 'node:fs';
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

/** Pages with updated > this many days ago are considered stale */
const STALE_DAYS = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiLintOptions {
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** OpenClaw sessions directory. Defaults to ~/.openclaw/agents/main/sessions */
  sessions?: string;
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

interface StalePage {
  /** Wiki-relative path */
  path: string;
  /** updated date from frontmatter */
  updated: string;
}

interface FrontmatterIssue {
  /** Wiki-relative path */
  path: string;
  /** List of missing field names */
  missingFields: string[];
}

interface LintReport {
  orphanPages: OrphanPage[];
  brokenLinks: BrokenLink[];
  stalePages: StalePage[];
  frontmatterIssues: FrontmatterIssue[];
}

// ---------------------------------------------------------------------------
// Chat log loading (mirrors wiki-dream-scan approach)
// ---------------------------------------------------------------------------

/**
 * Load today's chat log text from OpenClaw session JSONL files.
 * Returns combined raw text (user messages only), capped at maxChars.
 */
function loadTodaysChatText(sessionsDir: string, datePrefix: string, maxChars = 12000): string {
  if (!existsSync(sessionsDir)) return '';

  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return '';
  }

  const todayFiles = files.filter((f) => {
    try {
      const mtime = statSync(join(sessionsDir, f)).mtime;
      return mtime.toISOString().startsWith(datePrefix);
    } catch {
      return false;
    }
  });

  let combined = '';

  for (const f of todayFiles) {
    try {
      const lines = readFileSync(join(sessionsDir, f), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj['type'] === 'message') {
            const msg = obj['message'] as Record<string, unknown> | undefined;
            if (!msg || msg['role'] !== 'user') continue;
            const content = msg['content'];
            let text = '';
            if (Array.isArray(content)) {
              text = content
                .filter((c: unknown) => (c as Record<string, unknown>)['type'] === 'text')
                .map((c: unknown) => String((c as Record<string, unknown>)['text'] ?? ''))
                .join(' ');
            } else if (typeof content === 'string') {
              text = content;
            }
            if (text.includes('[PLUMB MEMORY]') || !text.trim()) continue;
            const ts = String(obj['timestamp'] ?? '');
            if (ts && !ts.startsWith(datePrefix)) continue;
            combined += text + '\n';
            if (combined.length > maxChars) {
              combined = combined.slice(0, maxChars);
              return combined;
            }
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return combined;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function daysBetween(isoA: string, isoB: string): number {
  const a = new Date(isoA).getTime();
  const b = new Date(isoB).getTime();
  return Math.abs(b - a) / (1000 * 60 * 60 * 24);
}

function nowHHMM(): string {
  return new Date().toTimeString().slice(0, 5);
}

// ---------------------------------------------------------------------------
// Title-to-path index
// ---------------------------------------------------------------------------

interface PageInfo {
  relPath: string;
  title: string;
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

    pages.push({ relPath, title, updated, frontmatterMissing: missingFields });
    titleToPath.set(title.toLowerCase(), relPath);

    // Also index by basename slug for lowercase/hyphenated wikilinks
    const baseSlug = relPath.replace(/^.*\//, '').replace(/\.md$/, '').toLowerCase();
    slugToPath.set(baseSlug, relPath);

    // Index any aliases declared in frontmatter (aliases: [Clay, Clay W])
    const aliasesRaw = frontmatter['aliases'];
    if (Array.isArray(aliasesRaw)) {
      for (const alias of aliasesRaw) {
        if (typeof alias === 'string' && alias.trim()) {
          titleToPath.set(alias.toLowerCase(), relPath);
        }
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
 * Check 1: Orphan pages — pages that no other page links to.
 * A page is NOT an orphan if its title appears as a wikilink target in any other page.
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
    const titleLc = page.title.toLowerCase();
    const baseSlug = page.relPath.replace(/^.*\//, '').replace(/\.md$/, '').toLowerCase();
    if (linkedTitles.has(titleLc)) continue;
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
 * Check 3: Stale pages — pages with updated >30 days ago that appear in today's chat.
 * Checks chat text for [[wikilink]] patterns referencing page titles.
 */
function detectStalePages(
  pages: PageInfo[],
  chatText: string,
  today: string,
): StalePage[] {
  if (!chatText.trim()) return [];

  // Extract wikilink targets from the chat text
  const chatLinks = new Set(
    extractWikilinks(chatText).map((t) => t.toLowerCase()),
  );

  // Also check if page titles appear as plain text in the chat
  const stale: StalePage[] = [];
  for (const page of pages) {
    const updated = page.updated;
    if (!updated) continue;

    const daysOld = daysBetween(updated, today);
    if (daysOld <= STALE_DAYS) continue;

    // Check if this page's title appears in the chat wikilinks or as plain text
    const titleLower = page.title.toLowerCase();
    const referencedInChat =
      chatLinks.has(titleLower) ||
      chatText.toLowerCase().includes(`[[${titleLower}]]`) ||
      chatText.toLowerCase().includes(titleLower);

    if (referencedInChat) {
      stale.push({ path: page.relPath, updated });
    }
  }

  return stale;
}

/**
 * Check 4: Frontmatter inconsistencies — missing required fields.
 */
function detectFrontmatterIssues(pages: PageInfo[]): FrontmatterIssue[] {
  return pages
    .filter((p) => p.frontmatterMissing.length > 0)
    .map((p) => ({ path: p.relPath, missingFields: p.frontmatterMissing }));
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
    report.stalePages.length +
    report.frontmatterIssues.length;

  const lines: string[] = [
    `\n## ${today}\n`,
    `### Lint Report (${timeStr} MT)`,
    '',
  ];

  // Orphan pages
  lines.push(`**Orphan pages** (no inbound links): ${report.orphanPages.length}`);
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

  // Stale pages
  lines.push(
    `**Stale pages** (>30 days old, referenced today): ${report.stalePages.length}`,
  );
  if (report.stalePages.length > 0) {
    for (const s of report.stalePages) {
      lines.push(`- ${s.path} (updated: ${s.updated})`);
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
  const sessionsDir =
    options.sessions ?? join(homedir(), '.openclaw', 'agents', 'main', 'sessions');
  const dryRun = options.dryRun ?? false;
  const timeStr = nowHHMM();

  console.log(`Wiki lint — ${today}`);
  console.log(`  wiki:     ${wikiRoot}`);
  console.log(`  sessions: ${sessionsDir}`);
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

  // --- Load today's chat text for stale page detection ---
  console.log('Loading today\'s chat logs…');
  const chatText = loadTodaysChatText(sessionsDir, today);
  if (chatText) {
    console.log(`  Loaded ${chatText.length} chars of chat context.`);
  } else {
    console.log('  No chat logs found for today.');
  }

  // --- Run lint checks ---
  console.log('\nRunning lint checks…');

  const orphanPages = detectOrphans(pages, linkMap);
  console.log(`  Orphan pages:     ${orphanPages.length}`);

  const brokenLinks = detectBrokenLinks(linkMap, titleToPath, slugToPath);
  console.log(`  Broken wikilinks: ${brokenLinks.length}`);

  const stalePages = detectStalePages(pages, chatText, today);
  console.log(`  Stale pages:      ${stalePages.length}`);

  const frontmatterIssues = detectFrontmatterIssues(pages);
  console.log(`  Frontmatter issues: ${frontmatterIssues.length}`);

  const report: LintReport = { orphanPages, brokenLinks, stalePages, frontmatterIssues };
  const totalIssues =
    orphanPages.length + brokenLinks.length + stalePages.length + frontmatterIssues.length;

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
