/**
 * wiki-surgical-repair.ts — deterministic wiki hygiene for the dream cron.
 *
 * Repairs only lint failures where the correct edit is uniquely determined by
 * existing wiki state or by the page path/schema. Ambiguous/editorial cleanup is
 * reported, not applied.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  extractTitle,
  extractWikilinks,
  formatPage,
  listWikiPages,
  parseFrontmatter,
} from '@getplumb/core';
import type { WikiFrontmatter } from '@getplumb/core';

const MAX_TOUCHED_PAGES = 10;
const MAX_REPAIRS_PER_PAGE = 5;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const TYPE_BY_DIR: Record<string, string> = {
  people: 'person',
  companies: 'company',
  tools: 'tool',
  projects: 'project',
  interviews: 'interview',
  concepts: 'concept',
  stories: 'story',
  life: 'life',
};

export interface WikiSurgicalRepairOptions {
  wiki?: string;
  date?: string;
  dryRun?: boolean;
}

export interface WikiSurgicalRepairResult {
  pagesExamined: number;
  pagesTouched: number;
  wikilinksRepaired: number;
  frontmatterRepaired: number;
  skippedAmbiguous: number;
  skippedUnsafe: number;
}

interface PageRecord {
  relPath: string;
  raw: string;
  body: string;
  frontmatter: WikiFrontmatter | null;
  title: string;
  aliases: string[];
}

interface RepairLogItem {
  path: string;
  kind: 'wikilink' | 'frontmatter' | 'skipped';
  message: string;
}

function slugifyLinkTarget(target: string): string {
  return target
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]|[-/]$/g, '');
}

function slugifyLikeLint(target: string): string {
  return target
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function linkToken(target: string): string {
  return target.split('|')[0]?.trim() ?? target.trim();
}

function targetKey(target: string): string {
  return linkToken(target).toLowerCase();
}

function wikiTypeForPath(relPath: string): string | null {
  const dir = relPath.split('/')[0] ?? '';
  return TYPE_BY_DIR[dir] ?? null;
}

function firstH1LineIndex(lines: string[]): number {
  const idx = lines.findIndex((line) => line.trim().startsWith('# '));
  return idx === -1 ? Number.POSITIVE_INFINITY : idx;
}

function firstDelimiterLineIndex(lines: string[]): number {
  return lines.findIndex((line) => line.trim() === '---');
}

function tryParse(raw: string): { frontmatter: WikiFrontmatter; body: string } | null {
  try {
    return parseFrontmatter(raw);
  } catch {
    return null;
  }
}

function hasRequiredFrontmatter(fm: WikiFrontmatter): boolean {
  return Boolean(
    fm.type &&
      fm.created &&
      fm.updated &&
      Array.isArray(fm.source_refs) &&
      Array.isArray(fm.tags) &&
      fm.confidence,
  );
}

function normalizeTitleFromPath(relPath: string): string {
  return relPath
    .replace(/^.*\//, '')
    .replace(/\.md$/, '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function canonicalLinkTarget(page: PageRecord): string {
  return page.relPath.replace(/\.md$/, '');
}

function addIndex(index: Map<string, Set<string>>, key: string, relPath: string): void {
  const normalized = key.trim().toLowerCase();
  if (!normalized) return;
  const existing = index.get(normalized) ?? new Set<string>();
  existing.add(relPath);
  index.set(normalized, existing);
}

function buildTargetIndex(pages: PageRecord[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const page of pages) {
    addIndex(index, page.title, page.relPath);
    for (const alias of page.aliases) addIndex(index, alias, page.relPath);
    addIndex(index, page.relPath.replace(/\.md$/, ''), page.relPath);
    addIndex(index, page.relPath.replace(/^.*\//, '').replace(/\.md$/, ''), page.relPath);
    addIndex(index, slugifyLinkTarget(page.title), page.relPath);
    addIndex(index, slugifyLinkTarget(page.relPath.replace(/\.md$/, '')), page.relPath);
  }
  return index;
}

function buildLintResolutionIndexes(pages: PageRecord[]): {
  titleToPath: Map<string, string>;
  slugToPath: Map<string, string>;
} {
  const titleToPath = new Map<string, string>();
  const slugToPath = new Map<string, string>();
  for (const page of pages) {
    titleToPath.set(page.title.toLowerCase(), page.relPath);
    for (const alias of page.aliases) titleToPath.set(alias.toLowerCase(), page.relPath);
    slugToPath.set(page.relPath.replace(/^.*\//, '').replace(/\.md$/, '').toLowerCase(), page.relPath);
  }
  return { titleToPath, slugToPath };
}

function resolvesInCurrentLint(target: string, lintIndexes: ReturnType<typeof buildLintResolutionIndexes>): boolean {
  const token = linkToken(target);
  if (lintIndexes.titleToPath.has(token.toLowerCase())) return true;
  const slug = slugifyLikeLint(token);
  return Boolean(slug && lintIndexes.slugToPath.has(slug));
}

function resolveUniqueTarget(target: string, index: Map<string, Set<string>>): string | null | 'ambiguous' {
  const token = linkToken(target);
  const keys = [token.toLowerCase(), slugifyLinkTarget(token)];
  const matches = new Set<string>();
  for (const key of keys) {
    const paths = index.get(key);
    if (!paths) continue;
    for (const path of paths) matches.add(path);
  }
  if (matches.size === 0) return null;
  if (matches.size > 1) return 'ambiguous';
  return [...matches][0]!;
}

function replaceWikilinkTargets(raw: string, replacements: Map<string, string>): string {
  return raw.replace(/\[\[([^\]]+)\]\]/g, (full, inner: string) => {
    const token = linkToken(inner);
    const replacement = replacements.get(targetKey(inner));
    if (!replacement) return full;
    const display = inner.includes('|') ? inner.slice(inner.indexOf('|')) : '';
    return `[[${replacement}${display}]]`;
  });
}

function repairFrontmatter(raw: string, relPath: string, today: string): { raw: string; messages: string[] } {
  const messages: string[] = [];
  let next = raw;

  // Strip an LLM preface before the first frontmatter delimiter, but only when
  // the delimiter is before the H1 and the result parses.
  if (!next.startsWith('---')) {
    const lines = next.split('\n');
    const delimiterIdx = firstDelimiterLineIndex(lines);
    if (delimiterIdx > 0 && delimiterIdx < firstH1LineIndex(lines)) {
      const candidate = lines.slice(delimiterIdx).join('\n');
      if (tryParse(candidate)) {
        next = candidate;
        messages.push('stripped leading prose before frontmatter');
      }
    }
  }

  // Add a missing opening delimiter for pages that start with YAML fields and
  // already have a closing delimiter before the H1.
  if (!next.startsWith('---')) {
    const lines = next.split('\n');
    const delimiterIdx = firstDelimiterLineIndex(lines);
    if (delimiterIdx > 0 && delimiterIdx < firstH1LineIndex(lines) && /^[A-Za-z_]+:\s*/.test(lines[0] ?? '')) {
      const candidate = `---\n${next}`;
      if (tryParse(candidate)) {
        next = candidate;
        messages.push('added missing opening frontmatter delimiter');
      }
    }
  }

  const parsed = tryParse(next);
  if (!parsed) return { raw: next, messages };

  const fm = { ...parsed.frontmatter };
  let changedFields = false;
  const pathType = wikiTypeForPath(relPath);

  if (pathType && (!fm.type || fm.type !== pathType)) {
    fm.type = pathType as WikiFrontmatter['type'];
    changedFields = true;
    messages.push(`set type from path (${pathType})`);
  }

  if (!fm.created && DATE_PATTERN.test(fm.updated)) {
    fm.created = fm.updated;
    changedFields = true;
    messages.push('set missing created date from updated date');
  }

  if (!fm.updated && DATE_PATTERN.test(fm.created)) {
    fm.updated = fm.created;
    changedFields = true;
    messages.push('set missing updated date from created date');
  }

  if (!Array.isArray(fm.tags)) {
    fm.tags = [];
    changedFields = true;
    messages.push('normalized tags to an array');
  }

  if (!Array.isArray(fm.source_refs)) {
    fm.source_refs = [];
    changedFields = true;
    messages.push('normalized source_refs to an array');
  }

  if (!fm.confidence) {
    fm.confidence = 'medium';
    changedFields = true;
    messages.push('set missing confidence to medium');
  }

  if (changedFields && hasRequiredFrontmatter(fm)) {
    next = formatPage(fm, parsed.body);
  }

  return { raw: next, messages };
}

async function loadPages(wikiRoot: string): Promise<PageRecord[]> {
  const relPaths = await listWikiPages(wikiRoot);
  const pages: PageRecord[] = [];

  for (const relPath of relPaths) {
    const raw = readFileSync(join(wikiRoot, relPath), 'utf8');
    const parsed = tryParse(raw);
    const body = parsed?.body ?? raw;
    const fm = parsed?.frontmatter ?? null;
    const aliasesRaw = fm ? (fm as Record<string, unknown>)['aliases'] : undefined;
    const aliases = Array.isArray(aliasesRaw)
      ? aliasesRaw.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
      : [];
    pages.push({
      relPath,
      raw,
      body,
      frontmatter: fm,
      title: extractTitle(body) ?? normalizeTitleFromPath(relPath),
      aliases,
    });
  }

  return pages;
}

async function appendRepairLog(wikiRoot: string, today: string, items: RepairLogItem[], dryRun: boolean): Promise<void> {
  if (items.length === 0) return;
  const byKind = {
    wikilink: items.filter((item) => item.kind === 'wikilink'),
    frontmatter: items.filter((item) => item.kind === 'frontmatter'),
    skipped: items.filter((item) => item.kind === 'skipped'),
  };
  const lines = [
    `\n## ${today}\n`,
    '### Surgical Repair Report',
    '',
    `- Wikilink repairs: ${byKind.wikilink.length}`,
    `- Frontmatter repairs: ${byKind.frontmatter.length}`,
    `- Skipped ambiguous/unsafe items: ${byKind.skipped.length}`,
    '',
  ];
  for (const item of items) lines.push(`- ${item.kind}: ${item.path} — ${item.message}`);
  lines.push('');
  const entry = lines.join('\n');

  if (dryRun) {
    console.log('\n[dry-run] Would append surgical repair report to log.md:');
    console.log(entry);
    return;
  }

  await appendFile(join(wikiRoot, 'log.md'), entry, 'utf8');
}

export async function wikiSurgicalRepairCommand(
  options: WikiSurgicalRepairOptions = {},
): Promise<WikiSurgicalRepairResult> {
  const today = options.date ?? new Date().toISOString().slice(0, 10);
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');
  const dryRun = options.dryRun ?? false;

  console.log(`Wiki surgical repair — ${today}`);
  console.log(`  wiki: ${wikiRoot}`);
  console.log(`  policy: deterministic, local, reversible repairs only`);
  if (dryRun) console.log('  [dry-run mode]');

  if (!existsSync(wikiRoot)) {
    console.log('\nWiki root not found — nothing to repair.');
    return { pagesExamined: 0, pagesTouched: 0, wikilinksRepaired: 0, frontmatterRepaired: 0, skippedAmbiguous: 0, skippedUnsafe: 0 };
  }

  let pages = await loadPages(wikiRoot);
  const logs: RepairLogItem[] = [];
  const touched = new Set<string>();
  const repairsPerPage = new Map<string, number>();

  const canTouch = (relPath: string): boolean => {
    if (!touched.has(relPath) && touched.size >= MAX_TOUCHED_PAGES) return false;
    return (repairsPerPage.get(relPath) ?? 0) < MAX_REPAIRS_PER_PAGE;
  };
  const markRepair = (relPath: string): void => {
    touched.add(relPath);
    repairsPerPage.set(relPath, (repairsPerPage.get(relPath) ?? 0) + 1);
  };

  let frontmatterRepaired = 0;
  let skippedUnsafe = 0;

  for (const page of pages) {
    if (!canTouch(page.relPath)) break;
    const result = repairFrontmatter(page.raw, page.relPath, today);
    if (result.raw === page.raw || result.messages.length === 0) continue;
    if (!tryParse(result.raw)) {
      skippedUnsafe++;
      logs.push({ path: page.relPath, kind: 'skipped', message: 'frontmatter repair candidate did not parse cleanly' });
      continue;
    }
    markRepair(page.relPath);
    frontmatterRepaired += result.messages.length;
    logs.push({ path: page.relPath, kind: 'frontmatter', message: result.messages.join('; ') });
    if (!dryRun) writeFileSync(join(wikiRoot, page.relPath), result.raw, 'utf8');
    console.log(`  frontmatter: ${page.relPath} — ${result.messages.join('; ')}`);
  }

  // Rebuild the index after frontmatter fixes so aliases restored by delimiter
  // repairs are available to wikilink repair in the same run.
  pages = dryRun ? await loadPages(wikiRoot) : await loadPages(wikiRoot);
  const index = buildTargetIndex(pages);
  const lintIndexes = buildLintResolutionIndexes(pages);
  const byPath = new Map(pages.map((page) => [page.relPath, page]));

  let wikilinksRepaired = 0;
  let skippedAmbiguous = 0;

  for (const page of pages) {
    if (!canTouch(page.relPath)) break;
    const replacements = new Map<string, string>();
    for (const link of extractWikilinks(page.body)) {
      if (!canTouch(page.relPath)) break;
      if (resolvesInCurrentLint(link, lintIndexes)) continue;
      const token = linkToken(link);
      const resolved = resolveUniqueTarget(token, index);
      if (resolved === 'ambiguous') {
        skippedAmbiguous++;
        logs.push({ path: page.relPath, kind: 'skipped', message: `ambiguous wikilink [[${link}]]` });
        continue;
      }
      if (!resolved) {
        skippedUnsafe++;
        logs.push({ path: page.relPath, kind: 'skipped', message: `unresolved wikilink [[${link}]]` });
        continue;
      }
      const targetPage = byPath.get(resolved);
      if (!targetPage) continue;
      const canonical = canonicalLinkTarget(targetPage);
      if (targetKey(link) === canonical.toLowerCase()) continue;
      replacements.set(targetKey(link), canonical);
      markRepair(page.relPath);
      wikilinksRepaired++;
      logs.push({ path: page.relPath, kind: 'wikilink', message: `[[${link}]] → [[${canonical}]]` });
    }

    if (replacements.size === 0) continue;
    const nextRaw = replaceWikilinkTargets(page.raw, replacements);
    if (!dryRun) writeFileSync(join(wikiRoot, page.relPath), nextRaw, 'utf8');
    console.log(`  wikilinks: ${page.relPath} — ${replacements.size} repair(s)`);
  }

  await appendRepairLog(wikiRoot, today, logs, dryRun);

  console.log(`  Pages examined: ${pages.length}`);
  console.log(`  Pages touched: ${touched.size}`);
  console.log(`  Wikilink repairs: ${wikilinksRepaired}`);
  console.log(`  Frontmatter repairs: ${frontmatterRepaired}`);
  console.log(`  Skipped ambiguous: ${skippedAmbiguous}`);
  console.log(`  Skipped unsafe/unresolved: ${skippedUnsafe}`);

  return {
    pagesExamined: pages.length,
    pagesTouched: touched.size,
    wikilinksRepaired,
    frontmatterRepaired,
    skippedAmbiguous,
    skippedUnsafe,
  };
}
