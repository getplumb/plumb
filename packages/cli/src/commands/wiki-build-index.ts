/**
 * wiki-build-index.ts — Build index.md and per-directory _index.md files.
 *
 * Scans all wiki pages under ~/.plumb/wiki/, then writes:
 *   - index.md     Master catalog of all pages, grouped by directory
 *   - <dir>/_index.md  Per-directory table of pages
 *
 * Each entry includes: wikilink, one-line summary, type tag, updated date.
 * Summary is the first non-empty paragraph after the H1 title in the page body.
 *
 * Can be run standalone (post-seed rebuild) or called from the seed pipeline.
 *
 * Usage:
 *   plumb wiki-build-index [--wiki <path>] [--dry-run]
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { listWikiPages, readWikiPage } from '@getplumb/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiBuildIndexOptions {
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** If true, print what would be written without writing anything */
  dryRun?: boolean;
}

interface PageEntry {
  /** Relative path from wikiRoot, e.g. "people/jordan-lee.md" */
  relPath: string;
  /** Directory name, e.g. "people" */
  dir: string;
  /** H1 title, falls back to filename stem */
  title: string;
  /** One-line summary from first paragraph after H1 */
  summary: string;
  /** Entity type from frontmatter */
  type: string;
  /** Last updated date from frontmatter (YYYY-MM-DD) */
  updated: string;
}

// ---------------------------------------------------------------------------
// Summary extraction
// ---------------------------------------------------------------------------

/**
 * Extract the one-line summary from a page body.
 * Returns the first non-empty, non-heading line that appears after the H1.
 * Falls back to empty string if nothing is found.
 */
function extractSummary(body: string): string {
  const lines = body.split('\n');
  let pastH1 = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!pastH1) {
      if (trimmed.startsWith('# ')) {
        pastH1 = true;
      }
      continue;
    }

    // Skip blank lines and section headings
    if (!trimmed || trimmed.startsWith('#')) continue;

    return trimmed;
  }

  return '';
}

/**
 * Derive a display title from a relative file path (slug → Title Case).
 * e.g. "people/jordan-lee.md" → "Jordan Lee"
 */
function slugToTitle(relPath: string): string {
  const stem = relPath.replace(/\.md$/, '').replace(/^.*\//, '');
  return stem
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Markdown builders
// ---------------------------------------------------------------------------

/**
 * Build the content of the master index.md.
 * Pages are grouped by directory, sorted alphabetically within each group.
 * Directories are sorted alphabetically.
 */
function buildMasterIndex(
  entriesByDir: Map<string, PageEntry[]>,
  today: string,
): string {
  const lines: string[] = [
    '# Wiki Index',
    '',
    `_Last updated: ${today}_`,
    '',
  ];

  const sortedDirs = [...entriesByDir.keys()].sort();

  for (const dir of sortedDirs) {
    const entries = entriesByDir.get(dir)!;
    if (entries.length === 0) continue;

    lines.push(`## ${dir}`);
    lines.push('');
    lines.push('| Page | Summary | Type | Updated |');
    lines.push('|------|---------|------|---------|');

    for (const entry of entries) {
      const link = `[[${entry.title}]]`;
      const summary = escapeTableCell(entry.summary);
      const type = escapeTableCell(entry.type);
      const updated = escapeTableCell(entry.updated);
      lines.push(`| ${link} | ${summary} | ${type} | ${updated} |`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build the content of a _index.md for a single directory.
 */
function buildDirIndex(dir: string, entries: PageEntry[], today: string): string {
  const dirTitle = dir.charAt(0).toUpperCase() + dir.slice(1);
  const lines: string[] = [
    `# ${dirTitle}`,
    '',
    `_Last updated: ${today}_`,
    '',
  ];

  if (entries.length === 0) {
    lines.push('_No pages in this directory._');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('| Page | Summary | Updated |');
  lines.push('|------|---------|---------|');

  for (const entry of entries) {
    const link = `[[${entry.title}]]`;
    const summary = escapeTableCell(entry.summary);
    const updated = escapeTableCell(entry.updated);
    lines.push(`| ${link} | ${summary} | ${updated} |`);
  }

  lines.push('');
  return lines.join('\n');
}

/** Escape pipe characters in a markdown table cell value. */
function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/**
 * Build index.md and per-directory _index.md files from all wiki pages.
 * Callable standalone or from the seed pipeline.
 */
export async function wikiBuildIndexCommand(
  options: WikiBuildIndexOptions = {},
): Promise<void> {
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');
  const dryRun = options.dryRun ?? false;
  const today = new Date().toISOString().slice(0, 10);

  // --- Discover all wiki pages ---
  let relPaths: string[];
  try {
    relPaths = await listWikiPages(wikiRoot);
  } catch (err) {
    // Wiki root doesn't exist yet — nothing to index
    console.log(`Wiki root not found at ${wikiRoot}. Nothing to index.`);
    return;
  }

  if (relPaths.length === 0) {
    console.log('No wiki pages found. Writing empty indexes.');
  } else {
    console.log(`Found ${relPaths.length} wiki pages. Building index…`);
  }

  // --- Read and parse each page ---
  const entriesByDir = new Map<string, PageEntry[]>();
  let parseErrors = 0;

  for (const relPath of relPaths) {
    // Determine directory (root-level files go in "_root")
    const slashIdx = relPath.indexOf('/');
    const dir = slashIdx !== -1 ? relPath.slice(0, slashIdx) : '_root';

    let entry: PageEntry;
    try {
      const page = await readWikiPage(wikiRoot, relPath);
      const title = page.title ?? slugToTitle(relPath);
      // Prefer frontmatter summary field; fall back to first paragraph in body
      const summary = (page.frontmatter.summary as string | undefined)?.trim() || extractSummary(page.body);
      entry = {
        relPath,
        dir,
        title,
        summary,
        type: page.frontmatter.type ?? '',
        updated: page.frontmatter.updated ?? '',
      };
    } catch {
      // Gracefully handle parse failures (e.g. missing frontmatter)
      parseErrors++;
      entry = {
        relPath,
        dir,
        title: slugToTitle(relPath),
        summary: '',
        type: '',
        updated: '',
      };
    }

    if (!entriesByDir.has(dir)) {
      entriesByDir.set(dir, []);
    }
    entriesByDir.get(dir)!.push(entry);
  }

  if (parseErrors > 0) {
    console.warn(`  Warning: ${parseErrors} page(s) could not be parsed and will have empty summaries.`);
  }

  // Sort entries within each directory alphabetically by title
  for (const entries of entriesByDir.values()) {
    entries.sort((a, b) => a.title.localeCompare(b.title));
  }

  // --- Build master index.md ---
  const masterContent = buildMasterIndex(entriesByDir, today);
  const masterPath = join(wikiRoot, 'index.md');

  if (dryRun) {
    console.log(`[Dry run] Would write ${masterPath} (${masterContent.length} chars)`);
  } else {
    await mkdir(wikiRoot, { recursive: true });
    await writeFile(masterPath, masterContent, 'utf8');
    console.log(`  Wrote ${masterPath}`);
  }

  // --- Build per-directory _index.md files ---
  const sortedDirs = [...entriesByDir.keys()].sort();

  for (const dir of sortedDirs) {
    // Skip the synthetic "_root" bucket — no subdirectory to write to
    if (dir === '_root') continue;

    const entries = entriesByDir.get(dir)!;
    const dirContent = buildDirIndex(dir, entries, today);
    const dirIndexPath = join(wikiRoot, dir, '_index.md');

    if (dryRun) {
      console.log(`[Dry run] Would write ${dirIndexPath} (${entries.length} entries)`);
    } else {
      await mkdir(join(wikiRoot, dir), { recursive: true });
      await writeFile(dirIndexPath, dirContent, 'utf8');
      console.log(`  Wrote ${dirIndexPath} (${entries.length} entries)`);
    }
  }

  if (!dryRun) {
    const dirCount = [...sortedDirs].filter((d) => d !== '_root').length;
    console.log(`Done. Indexed ${relPaths.length} pages across ${dirCount} directories.`);
  }
}
