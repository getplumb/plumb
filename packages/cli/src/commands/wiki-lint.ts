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
import { analyzeLinks, collectWikiCorpus } from '@getplumb/core';
import type { LinkFinding, WikiPageInput, WikiCorpusPage } from '@getplumb/core';

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

/** Link defects, already classified by the canonical resolver. */
type LinkIssues = LinkFinding[];

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
  linkIssues: LinkIssues;
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
// Corpus enumeration
// ---------------------------------------------------------------------------

/**
 * REWIRED 2026-08-14. This file used to enumerate the wiki itself:
 * `listAllMarkdown`, `isGeneratedPage`, the `.plumbignore` orphan-exemption
 * rule, the required-frontmatter list and `buildPageIndex` were all private
 * here. They now live in `collectWikiCorpus` in `@getplumb/core`, which
 * `collectWikiIntegrity` also uses.
 *
 * Same reason this file's link detection was replaced earlier the same day. Two
 * copies of "which files count, and how is each one classified" WILL drift, and
 * a linter and a health gate that quietly disagree about the corpus is exactly
 * how this wiki came to have three link detectors reporting 96, 329 and a third
 * number about the same 320 files. One enumeration, two consumers, one answer.
 */

// ---------------------------------------------------------------------------
// Lint checks
// ---------------------------------------------------------------------------

/**
 * Checks 1 and 2: orphan pages and link defects, both from the canonical
 * resolver in `@getplumb/core`.
 *
 * REPLACED 2026-08-14. This file previously carried its own title map, its own
 * `slugifyLinkTarget`, and its own orphan rule — one of three such
 * implementations in the repo, which reported 96 broken links where the nightly
 * dream reported 329. Roughly 70% of its findings were false: same-page
 * `[[#anchor]]` links it could not follow, `[[path.md]]` links whose files
 * exist, and `[[wikilink]]` written inside backticks in prose about wikilinks.
 * Nothing that noisy is actionable, so the real defects were never fixed.
 *
 * Link defects are now reported in classes with distinct remedies rather than
 * one "broken" pile: a missing page is a page to create, an ambiguous name is a
 * human decision, and a stale `#anchor` is a one-line edit.
 */
function detectLinkIssues(
  corpus: readonly WikiPageInput[],
  generated: readonly string[],
  orphanExempt: readonly string[],
): { orphans: OrphanPage[]; findings: LinkFinding[] } {
  const result = analyzeLinks([...corpus], {
    generatedPages: [...generated],
    orphanExempt: [...orphanExempt],
  });
  return {
    orphans: result.orphans.map((path) => ({ path })),
    findings: [...result.findings],
  };
}

/**
 * Check 3: Frontmatter inconsistencies — missing required fields.
 */
function detectFrontmatterIssues(pages: readonly WikiCorpusPage[]): FrontmatterIssue[] {
  return pages
    .filter((p) => p.missingFrontmatter.length > 0)
    .map((p) => ({ path: p.rel, missingFields: [...p.missingFrontmatter] }));
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
    report.linkIssues.length +
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

  // Link defects, split by remedy. Lumping these together is what made the old
  // report unactionable: a missing page, an ambiguous name and a renamed
  // heading want three different fixes from two different actors.
  const unresolved = report.linkIssues.filter((f) => f.status === 'unresolved');
  const ambiguous = report.linkIssues.filter((f) => f.status === 'ambiguous');
  const anchorMissing = report.linkIssues.filter((f) => f.status === 'anchor-missing');

  lines.push(`**Missing pages** (link target does not exist — the page-creation backlog): ${unresolved.length}`);
  for (const f of unresolved) {
    lines.push(`- ${f.page}:${f.line} → [[${f.target}]]`);
  }
  lines.push('');

  lines.push(`**Ambiguous link targets** (several pages answer to the name — needs a human): ${ambiguous.length}`);
  for (const f of ambiguous) {
    lines.push(`- ${f.page}:${f.line} → [[${f.target}]] — ${f.candidates.join(' | ')}`);
  }
  lines.push('');

  lines.push(`**Stale heading anchors** (page resolves, heading renamed): ${anchorMissing.length}`);
  for (const f of anchorMissing) {
    lines.push(`- ${f.page}:${f.line} → [[${f.raw}]]`);
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

async function appendToLog(wikiRoot: string, entry: string, dryRun: boolean): Promise<void> {
  const logPath = join(wikiRoot, 'log.md');

  if (dryRun) {
    console.log('\n[dry-run] Would append to log.md:');
    console.log(entry);
    return;
  }

  if (!existsSync(logPath)) {
    writeFileSync(logPath, '# Wiki Activity Log\n\nAppend-only. New entries go at the top (newest first). Never edit or delete past entries.\n\n---\n', 'utf8');
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
  const deadLetterPath = options.deadLetter ?? join(homedir(), '.plumb', 'wiki-queue-dead.jsonl');
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
  const { pages, corpus, generated, orphanExempt } = await collectWikiCorpus(wikiRoot);
  console.log(`  Found ${pages.length} content page(s), ${generated.length} generated.`);

  if (pages.length === 0) {
    console.log('No pages to lint.');
    return;
  }

  // --- Run lint checks ---
  console.log('\nRunning lint checks…');

  const { orphans: orphanPages, findings: linkIssues } = detectLinkIssues(corpus, generated, orphanExempt);
  console.log(`  Orphan pages:       ${orphanPages.length}`);
  console.log(`  Missing pages:      ${linkIssues.filter((f) => f.status === 'unresolved').length}`);
  console.log(`  Ambiguous targets:  ${linkIssues.filter((f) => f.status === 'ambiguous').length}`);
  console.log(`  Stale anchors:      ${linkIssues.filter((f) => f.status === 'anchor-missing').length}`);

  const frontmatterIssues = detectFrontmatterIssues(pages);
  console.log(`  Frontmatter issues: ${frontmatterIssues.length}`);

  const deadLetterItems = await readDeadLetterItems(deadLetterPath);
  console.log(`  Dead-letter items:  ${deadLetterItems.length}`);

  const report: LintReport = {
    orphanPages,
    linkIssues,
    frontmatterIssues,
    deadLetterItems,
  };

  const totalIssues =
    orphanPages.length +
    linkIssues.length +
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
