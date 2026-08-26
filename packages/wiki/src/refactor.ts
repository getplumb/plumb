/**
 * refactor.ts — Page refactor: deterministic H2-boundary splits with hysteresis + cooldown.
 *
 * Invoked during the dream cron to prevent pages from growing unbounded.
 *
 * Rules:
 *   - Split threshold:      ≥ 1200 words → eligible for a split
 *   - Merge-back threshold: < 600 words  → eligible for merge-back (not yet implemented)
 *   - Cooldown:             7 days between splits of the same page
 *   - Child page naming:    {parent-slug}-{section-slug}.md (same directory as parent)
 *   - OpenClaw dream model: Used only to pick which H2 section to externalize (max_tokens=100)
 *   - Inbound wikilinks:    Parent keeps a summary + [[child]] link — existing links still resolve
 *   - Log:                  Every split appended to log.md (parent, child, words before/after)
 *
 * Tie-breaking (when the model is not available or for deterministic fallback):
 *   1. Most outbound [[wikilinks]] in the section body
 *   2. Alphabetical by section title (a < z)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import {
  parseFrontmatter,
  formatPage,
  extractTitle,
  openDb,
  applyWikiSchema,
} from '@getplumb/core';
import type { WikiFrontmatter, WasmDb } from '@getplumb/core';
import { callOpenClawChat } from './openclaw-chat.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SPLIT_THRESHOLD_WORDS = 1200;
export const MERGE_THRESHOLD_WORDS = 600;
export const COOLDOWN_DAYS = 7;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface H2Section {
  /** Section title (heading text without leading ## ) */
  title: string;
  /** URL-safe slug of the title */
  slug: string;
  /** Raw body under this heading, NOT including the ## heading line */
  body: string;
  /** Full content including the ## heading line */
  fullContent: string;
  /** Word count of fullContent */
  wordCount: number;
  /** Number of outbound [[wikilinks]] in fullContent */
  outboundLinkCount: number;
}

export interface SplitRecord {
  parentPath: string;
  childPath: string;
  sectionTitle: string;
  wordsBefore: number;
  wordsAfter: number;
  childWords: number;
  splitAt: string;
}

export interface RefactorPhaseOptions {
  wikiRoot: string;
  wikiDbPath: string;
  /** Defaults to today's ISO date */
  today?: string;
  /** If true, skip all writes and API calls */
  dryRun?: boolean;
  /** Deprecated. Refactor now uses OpenClaw chat and falls back to deterministic tie-break on failure. */
  apiKey?: string;
}

export interface RefactorPhaseResult {
  splits: SplitRecord[];
  pagesExamined: number;
  sonnetTokensIn: number;
  sonnetTokensOut: number;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Count words in a string (whitespace-delimited tokens).
 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Convert a heading title to a URL-safe slug.
 *
 * Algorithm: lowercase → replace non-alphanumeric with hyphen → collapse hyphens → trim.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * Build the child page slug: {parentSlug}-{sectionSlug}
 * The parentSlug is the parent's path without the .md extension.
 *
 * Examples:
 *   parentSlug = "people/jordan-lee", sectionTitle = "Work History"
 *   → "people/jordan-lee-work-history"
 */
export function childPageSlug(parentSlug: string, sectionTitle: string): string {
  return `${parentSlug}-${slugify(sectionTitle)}`;
}

/**
 * Count outbound [[wikilinks]] in a block of markdown text.
 */
export function countOutboundLinks(text: string): number {
  const matches = text.match(/\[\[[^\]]+\]\]/g);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// H2 section parsing
// ---------------------------------------------------------------------------

/**
 * Parse a markdown body into H2 sections.
 *
 * Returns one entry per `## Heading` found. Content before the first H2 is
 * excluded (it stays in the parent summary). If there are no H2 headings,
 * returns an empty array (no externalizable sections).
 */
export function parseH2Sections(body: string): H2Section[] {
  const lines = body.split('\n');
  const rawSections: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (/^## /.test(line)) {
      if (current !== null) rawSections.push(current);
      current = { heading: line.slice(3).trim(), lines: [line] };
    } else if (current !== null) {
      current.lines.push(line);
    }
    // Lines before first H2 are ignored — they stay in the parent preamble
  }
  if (current !== null) rawSections.push(current);

  return rawSections.map((s) => {
    const fullContent = s.lines.join('\n').trimEnd();
    // body under the heading = everything except the first line (the ## line)
    const sectionBody = s.lines.slice(1).join('\n').trimEnd();
    return {
      title: s.heading,
      slug: slugify(s.heading),
      body: sectionBody,
      fullContent,
      wordCount: countWords(fullContent),
      outboundLinkCount: countOutboundLinks(fullContent),
    };
  });
}

// ---------------------------------------------------------------------------
// Deterministic section picker (tie-break)
// ---------------------------------------------------------------------------

/**
 * Pick the section to externalize using deterministic tie-breaking rules:
 *   1. Largest word count
 *   2. Most outbound [[wikilinks]]
 *   3. Alphabetical by section title (a < z)
 *
 * This is the fallback used when the model is not available and as the
 * tie-breaker when the model returns a title that matches multiple sections.
 */
export function pickSectionDeterministically(sections: H2Section[]): H2Section {
  if (sections.length === 0) throw new Error('No sections to pick from');
  if (sections.length === 1) return sections[0]!;

  // Sort descending by word count, then descending by outbound links, then ascending by title
  const sorted = [...sections].sort((a, b) => {
    if (b.wordCount !== a.wordCount) return b.wordCount - a.wordCount;
    if (b.outboundLinkCount !== a.outboundLinkCount) return b.outboundLinkCount - a.outboundLinkCount;
    return a.title.localeCompare(b.title);
  });
  return sorted[0]!;
}

// ---------------------------------------------------------------------------
// OpenClaw model section selection
// ---------------------------------------------------------------------------

/**
 * Ask the configured OpenClaw dream model which section to externalize.
 * Returns the exact section title or null if the response doesn't match
 * any known title (caller falls back to deterministic pick).
 *
 * max_tokens=100 — the response should be a single section title, nothing else.
 */
async function callModelPickSection(
  pageId: string,
  sections: H2Section[],
): Promise<{ title: string | null; tokensIn: number; tokensOut: number }> {
  const sectionList = sections
    .map((s) => `- ${s.title} | ${s.wordCount} words | ${s.outboundLinkCount} links`)
    .join('\n');

  const userContent =
    `Parent page: ${pageId}\n` +
    `H2 sections (title | word count | outbound links):\n${sectionList}\n\n` +
    `Which single section title should be externalized into its own child page? ` +
    `Pick the most self-contained sub-topic. Reply with ONLY the exact section title — no punctuation, no explanation.`;

  try {
    const response = await callOpenClawChat(
      'You are a wiki editor. You will receive a list of H2 sections from a wiki page. ' +
        'Reply with ONLY the exact section title to externalize, no other text.',
      userContent,
      100,
    );

    const tokensIn = response.inputTokens;
    const tokensOut = response.outputTokens;
    const raw = response.text;

    // Match response against known titles (case-insensitive)
    const known = sections.find(
      (s) => s.title.toLowerCase() === raw.toLowerCase(),
    );
    return { title: known?.title ?? null, tokensIn, tokensOut };
  } catch {
    // Non-fatal: fall back to deterministic pick
    return { title: null, tokensIn: 0, tokensOut: 0 };
  }
}

// ---------------------------------------------------------------------------
// Page content splitting
// ---------------------------------------------------------------------------

/**
 * Produce the updated parent body and the child page body for a section split.
 *
 * Parent body: the section is replaced with a short stub linking to the child.
 * Child body: starts with an H1 derived from the section title, then the section body.
 *
 * @param originalBody   Full markdown body of the parent page (after frontmatter)
 * @param section        The H2Section to externalize
 * @param childPageId    The new child page id (e.g. "people/jordan-lee-work-history")
 * @returns              { parentBody, childBody }
 */
export function splitPageContent(
  originalBody: string,
  section: H2Section,
  childPageId: string,
): { parentBody: string; childBody: string } {
  // Build the child page body
  const childTitle = section.title;
  // child slug (last segment after last /) as the wikilink display text
  const childSlug = childPageId.split('/').pop() ?? childPageId;
  const childBody = `\n# ${childTitle}\n\n${section.body.trim()}\n`;

  // Build the stub that replaces the section in the parent
  const stub =
    `## ${section.title}\n\n` +
    `*See [[${childSlug}]] for the full ${section.title.toLowerCase()} section.*\n`;

  // Replace the section in the original body.
  // Strategy: locate the section's fullContent and replace it with the stub.
  // We escape the fullContent for use in a regex by matching it literally.
  // Because fullContent may span multiple lines we use a line-by-line approach.
  const lines = originalBody.split('\n');
  const resultLines: string[] = [];
  let i = 0;
  let replaced = false;

  while (i < lines.length) {
    const line = lines[i]!;
    // Detect the start of this section: a ## line whose heading matches
    if (!replaced && /^## /.test(line) && line.slice(3).trim() === section.title) {
      // Emit the stub in place of the section
      resultLines.push(stub);
      // Skip all lines belonging to this section
      i++;
      while (i < lines.length && !/^## /.test(lines[i]!)) {
        i++;
      }
      replaced = true;
    } else {
      resultLines.push(line);
      i++;
    }
  }

  const parentBody = resultLines.join('\n');
  return { parentBody, childBody };
}

// ---------------------------------------------------------------------------
// Cooldown check
// ---------------------------------------------------------------------------

/**
 * Return true if the page is within the cooldown window (cannot split again yet).
 */
function isOnCooldown(db: WasmDb, pageId: string, todayDate: string): boolean {
  const stmt = db.prepare(`SELECT last_split_at FROM wiki_pages WHERE id = ?`);
  stmt.bind([pageId]);
  let lastSplit: string | null = null;
  if (stmt.step()) {
    const row = stmt.get({}) as { last_split_at: string | null };
    lastSplit = row.last_split_at;
  }
  stmt.finalize();

  if (!lastSplit) return false;

  const lastSplitDate = new Date(lastSplit.slice(0, 10) + 'T00:00:00Z');
  const today = new Date(todayDate + 'T00:00:00Z');
  const diffDays = (today.getTime() - lastSplitDate.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays < COOLDOWN_DAYS;
}

/**
 * Record the split timestamp for a page in wiki_pages.
 */
function recordSplitAt(db: WasmDb, pageId: string, splitAt: string): void {
  const stmt = db.prepare(`UPDATE wiki_pages SET last_split_at = ? WHERE id = ?`);
  stmt.bind([splitAt, pageId]);
  stmt.step();
  stmt.finalize();
}

// ---------------------------------------------------------------------------
// Log.md helper
// ---------------------------------------------------------------------------

async function appendSplitToLog(
  wikiRoot: string,
  record: SplitRecord,
  dryRun: boolean,
): Promise<void> {
  const logPath = join(wikiRoot, 'log.md');

  const entry = [
    ``,
    `### Split: ${record.splitAt.slice(0, 10)}`,
    ``,
    `| Field | Value |`,
    `| --- | --- |`,
    `| Parent | \`${record.parentPath}\` |`,
    `| Child | \`${record.childPath}\` |`,
    `| Section | ${record.sectionTitle} |`,
    `| Words before | ${record.wordsBefore} |`,
    `| Words after (parent) | ${record.wordsAfter} |`,
    `| Words (child) | ${record.childWords} |`,
    ``,
  ].join('\n');

  if (dryRun) {
    console.log('\n[dry-run] Would append split to log.md:');
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
// Main refactor phase
// ---------------------------------------------------------------------------

/**
 * Run the page-refactor phase.
 *
 * For each active wiki page with word_count ≥ SPLIT_THRESHOLD_WORDS:
 *   1. Skip if the page is within the COOLDOWN_DAYS window
 *   2. Parse H2 sections from the file on disk
 *   3. Skip if there are < 2 H2 sections (cannot split coherently)
 *   4. Ask OpenClaw dream model which section to externalize (falls back to deterministic pick)
 *   5. Write the child page and update the parent page via direct file I/O
 *   6. Record last_split_at + append a wiki_changelog entry
 *   7. Append the split record to log.md
 *
 * Returns stats about the run.
 */
export async function wikiRefactorPhase(
  options: RefactorPhaseOptions,
): Promise<RefactorPhaseResult> {
  const {
    wikiRoot,
    wikiDbPath,
    today = new Date().toISOString().slice(0, 10),
    dryRun = false,
  } = options;

  const result: RefactorPhaseResult = {
    splits: [],
    pagesExamined: 0,
    sonnetTokensIn: 0,
    sonnetTokensOut: 0,
  };

  if (!existsSync(wikiDbPath)) {
    console.log('  wiki.db not found — skipping refactor phase.');
    return result;
  }

  const db = await openDb(wikiDbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    applyWikiSchema(db);

    // Query all active pages over the threshold
    const pagesStmt = db.prepare(
      `SELECT id, path, word_count FROM wiki_pages
       WHERE status = 'active' AND word_count >= ?
       ORDER BY word_count DESC`,
    );
    pagesStmt.bind([SPLIT_THRESHOLD_WORDS]);
    const pages: Array<{ id: string; path: string; word_count: number }> = [];
    while (pagesStmt.step()) {
      pages.push(pagesStmt.get({}) as { id: string; path: string; word_count: number });
    }
    pagesStmt.finalize();

    console.log(
      `  Refactor: ${pages.length} page(s) with ≥${SPLIT_THRESHOLD_WORDS} words found.`,
    );

    for (const page of pages) {
      result.pagesExamined++;

      // 1. Cooldown check
      if (isOnCooldown(db, page.id, today)) {
        console.log(`  Skipping "${page.id}" (within ${COOLDOWN_DAYS}-day cooldown)`);
        continue;
      }

      // 2. Read page from disk
      const absPath = join(wikiRoot, page.path);
      if (!existsSync(absPath)) {
        console.log(`  Skipping "${page.id}" (file not found: ${page.path})`);
        continue;
      }

      let raw: string;
      try {
        raw = readFileSync(absPath, 'utf8');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  Warning: could not read "${page.path}": ${msg}`);
        continue;
      }

      const { frontmatter, body } = parseFrontmatter(raw);
      const wordsBefore = countWords(body);

      // 3. Parse H2 sections
      const sections = parseH2Sections(body);
      if (sections.length < 2) {
        console.log(
          `  Skipping "${page.id}" (${sections.length} H2 section(s) — need ≥ 2 to split)`,
        );
        continue;
      }

      // 4. Pick section to externalize
      const { title, tokensIn, tokensOut } = await callModelPickSection(page.id, sections);
      result.sonnetTokensIn += tokensIn;
      result.sonnetTokensOut += tokensOut;
      const chosenSection = title !== null
        ? sections.find((s) => s.title === title)!
        : pickSectionDeterministically(sections);

      // 5. Build child page id and path
      const parentSlug = page.id; // e.g. "people/jordan-lee"
      const childSlug = childPageSlug(parentSlug, chosenSection.title);
      const childRelPath = `${childSlug}.md`;
      const childAbsPath = join(wikiRoot, childRelPath);

      // 6. Produce updated content
      const { parentBody, childBody } = splitPageContent(body, chosenSection, childSlug);
      const wordsAfter = countWords(parentBody);
      const childWords = countWords(childBody);

      const splitAt = new Date().toISOString();

      // Build child frontmatter (derived from parent, created today)
      const childFm: WikiFrontmatter = {
        type: frontmatter.type,
        created: today,
        updated: today,
        confidence: frontmatter.confidence,
        tags: frontmatter.tags ?? [],
        source_refs: [`split:${page.id}`],
        status: 'active',
      };

      const parentFmUpdated: WikiFrontmatter = {
        ...frontmatter,
        updated: today,
      };

      if (dryRun) {
        console.log(`  [dry-run] Would split "${page.id}":`);
        console.log(`    → child: "${childRelPath}"`);
        console.log(`    → section: "${chosenSection.title}"`);
        console.log(
          `    → words: ${wordsBefore} → parent ${wordsAfter} + child ${childWords}`,
        );
        result.splits.push({
          parentPath: page.path,
          childPath: childRelPath,
          sectionTitle: chosenSection.title,
          wordsBefore,
          wordsAfter,
          childWords,
          splitAt,
        });
        continue;
      }

      // Write child page
      mkdirSync(dirname(childAbsPath), { recursive: true });
      const childRaw = formatPage(childFm, childBody);
      writeFileSync(childAbsPath, childRaw, 'utf8');

      // Write updated parent
      const parentRaw = formatPage(parentFmUpdated, parentBody);
      writeFileSync(absPath, parentRaw, 'utf8');

      // 7. Record cooldown in wiki.db
      recordSplitAt(db, page.id, splitAt);

      // Append wiki_changelog entry for parent update
      const changelogParentStmt = db.prepare(
        `INSERT INTO wiki_changelog (page_id, action, detail, source_ref, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      changelogParentStmt.bind([
        page.id,
        'updated',
        JSON.stringify({
          split_child: childSlug,
          section: chosenSection.title,
          words_before: wordsBefore,
          words_after: wordsAfter,
        }),
        `refactor:${today}`,
        splitAt,
      ]);
      changelogParentStmt.step();
      changelogParentStmt.finalize();

      // Child creation — insert into wiki_pages first
      const insertChildStmt = db.prepare(
        `INSERT OR IGNORE INTO wiki_pages
         (id, path, type, title, created, updated, confidence, tags, source_refs, status, word_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      );
      insertChildStmt.bind([
        childSlug,
        childRelPath,
        childFm.type,
        extractTitle(childBody) ?? chosenSection.title,
        today,
        today,
        childFm.confidence,
        JSON.stringify(childFm.tags),
        JSON.stringify(childFm.source_refs),
        childWords,
      ]);
      insertChildStmt.step();
      insertChildStmt.finalize();

      // Append wiki_changelog entry for child creation
      const changelogChildStmt = db.prepare(
        `INSERT INTO wiki_changelog (page_id, action, detail, source_ref, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      changelogChildStmt.bind([
        childSlug,
        'created',
        JSON.stringify({
          split_from: page.id,
          section: chosenSection.title,
          words: childWords,
        }),
        `refactor:${today}`,
        splitAt,
      ]);
      changelogChildStmt.step();
      changelogChildStmt.finalize();

      const record: SplitRecord = {
        parentPath: page.path,
        childPath: childRelPath,
        sectionTitle: chosenSection.title,
        wordsBefore,
        wordsAfter,
        childWords,
        splitAt,
      };

      result.splits.push(record);

      console.log(
        `  Split "${page.id}" → "${childRelPath}" ` +
          `(section: "${chosenSection.title}", ${wordsBefore}w → ${wordsAfter}w + ${childWords}w child)`,
      );

      // 8. Log to log.md
      await appendSplitToLog(wikiRoot, record, false);
    }
  } finally {
    db.close();
  }

  return result;
}
