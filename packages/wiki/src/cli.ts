#!/usr/bin/env node
/**
 * cli.ts — Plumb Wiki CLI: index and validate commands.
 *
 * Usage:
 *   node dist/cli.js index <wikiRoot> [--db <path>] [--verbose] [--no-contextual]
 *   node dist/cli.js validate <wikiRoot> [--fix]
 *
 * index: Build wiki.db from a directory of markdown. This is the bootstrap the
 *   search service cannot perform for itself — it opens wiki.db read-only, so
 *   without this command a fresh install has a service and no database to serve.
 *   Re-running is incremental: pages whose content_hash is unchanged are skipped.
 *
 *   --db            Where to write wiki.db. Defaults to ~/.plumb/wiki.db.
 *   --verbose       Per-page progress.
 *   --no-contextual Skip contextual sidecar embeddings. See the exit codes below
 *                   before reaching for this.
 *
 * validate: Scan all wiki pages under <wikiRoot>, report frontmatter errors.
 *   --fix   Auto-repair pages with code-fenced frontmatter (strips the fence).
 *           Only repairs the code-fence case; other errors require manual fixes.
 *
 * Exit codes:
 *   0  index: every chunk indexed, contextual coverage complete
 *      validate: all pages valid (or all fixable pages were fixed with --fix)
 *   1  index: pages failed to embed, or contextual coverage came out partial
 *      validate: one or more pages have validation errors
 *
 *   Partial contextual coverage is an ERROR, not a warning, because the search
 *   engine's contextual gate is all-or-nothing: one missing sidecar row demotes
 *   every query to keyword-only BM25, and it does so quietly. A half-indexed
 *   wiki that exits 0 is precisely how that failure reaches a user unnoticed.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { listWikiPages, runWikiEmbed, checkWikiCoverage } from '@getplumb/core';
import { validateRawContent } from './frontmatter-validator.js';

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // A flag's value is positional too, so drop it before picking the wiki root.
  const dbFlagValue = flagValue(args, '--db');
  const positional = args.filter((a) => !a.startsWith('--') && a !== dbFlagValue);
  const defaultWikiRoot = join(homedir(), '.plumb', 'wiki');

  if (args[0] === 'index') {
    await runIndex(positional[1] ?? defaultWikiRoot, {
      dbPath: dbFlagValue ?? join(homedir(), '.plumb', 'wiki.db'),
      verbose: args.includes('--verbose'),
      contextual: !args.includes('--no-contextual'),
    });
  } else if (args[0] === 'validate') {
    await runValidate(positional[1] ?? defaultWikiRoot, args.includes('--fix'));
  } else {
    console.error('Usage: plumb-wiki index <wikiRoot> [--db <path>] [--verbose] [--no-contextual]');
    console.error('       plumb-wiki validate <wikiRoot> [--fix]');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// index command
// ---------------------------------------------------------------------------

interface IndexOptions {
  dbPath: string;
  verbose: boolean;
  contextual: boolean;
}

async function runIndex(wikiRoot: string, options: IndexOptions): Promise<void> {
  console.log('Indexing wiki…');
  console.log(`  wiki: ${wikiRoot}`);
  console.log(`  db:   ${options.dbPath}`);
  console.log(`  contextual: ${options.contextual ? 'yes' : 'no (keyword-only search)'}\n`);

  let stats;
  try {
    stats = await runWikiEmbed({
      wikiRoot,
      dbPath: options.dbPath,
      verbose: options.verbose,
      contextualRefresh: options.contextual,
    });
  } catch (err) {
    console.error(`\nIndexing failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log('');
  console.log(`  Total pages:  ${stats.total}`);
  console.log(`  Embedded:     ${stats.embedded}  (${stats.chunks} chunks)`);
  console.log(`  Skipped:      ${stats.skipped}  (hash unchanged)`);
  if (stats.errors > 0) console.log(`  Errors:       ${stats.errors}`);

  // Report what the SERVICE will actually see, not just what the indexer did.
  // These are different questions: the indexer reports the work it performed,
  // coverage reports the state it left behind.
  const coverage = await checkWikiCoverage({ wikiRoot, dbPath: options.dbPath });
  console.log('');
  console.log(`  Indexed pages:      ${coverage.indexedCount} / ${coverage.diskCount} on disk`);
  console.log(`  Chunks:             ${coverage.chunkCount}`);
  if (options.contextual) {
    console.log(`  Contextual:         ${coverage.contextualCount}  (gap: ${coverage.embeddingGap})`);
  }

  const problems: string[] = [];
  if (stats.errors > 0) problems.push(`${stats.errors} page(s) failed to embed`);
  if (coverage.missing.length > 0) problems.push(`${coverage.missing.length} page(s) on disk were never indexed`);
  if (options.contextual && coverage.embeddingGap > 0) {
    problems.push(
      `contextual coverage is partial (${coverage.embeddingGap} chunk(s) short) — ` +
        'the search engine will silently fall back to keyword-only BM25 until this is 0',
    );
  }

  if (problems.length > 0) {
    console.error('\nIndex is not serviceable:');
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }

  console.log('\nIndex complete and serviceable.');
}

// ---------------------------------------------------------------------------
// validate command
// ---------------------------------------------------------------------------

interface PageReport {
  relPath: string;
  hasCodeFence: boolean;
  errors: Array<{ field: string; message: string }>;
  fixed: boolean;
}

async function runValidate(wikiRoot: string, fixMode: boolean): Promise<void> {
  console.log(`Scanning wiki at: ${wikiRoot}`);
  if (fixMode) {
    console.log('Fix mode enabled — will auto-repair code-fenced frontmatter.\n');
  } else {
    console.log('');
  }

  let relPaths: string[];
  try {
    relPaths = await listWikiPages(wikiRoot, { includeArchive: true });
  } catch (err) {
    console.error(
      `Error: Cannot read wiki root "${wikiRoot}": ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  if (relPaths.length === 0) {
    console.log('No wiki pages found.');
    process.exit(0);
  }

  console.log(`Found ${relPaths.length} page(s). Validating...`);

  const broken: PageReport[] = [];
  let fixedCount = 0;
  let codeOnlyCount = 0;

  for (const relPath of relPaths) {
    const absPath = join(wikiRoot, relPath);
    let rawContent: string;
    try {
      rawContent = await readFile(absPath, 'utf8');
    } catch {
      console.error(`  [ERROR] Cannot read: ${relPath}`);
      continue;
    }

    const result = validateRawContent(rawContent);

    if (result.valid) continue;

    const report: PageReport = {
      relPath,
      hasCodeFence: result.hasCodeFence,
      errors: result.errors,
      fixed: false,
    };

    // Fix mode: auto-repair code-fence-only broken pages
    if (fixMode && result.hasCodeFence && result.fixedContent !== undefined) {
      // Re-validate the fixed content to see if fencing was the only issue
      const fixedResult = validateRawContent(result.fixedContent);
      if (fixedResult.valid) {
        try {
          await writeFile(absPath, result.fixedContent, 'utf8');
          report.fixed = true;
          fixedCount++;
          codeOnlyCount++;
        } catch (writeErr) {
          console.error(
            `  [ERROR] Cannot write fix to: ${relPath}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
          );
        }
      } else {
        // Code fence stripped but other errors remain — report both
        report.errors = fixedResult.errors;
        broken.push(report);
      }
    } else {
      broken.push(report);
    }
  }

  // Summary
  console.log('');
  console.log('─'.repeat(60));

  if (fixMode && fixedCount > 0) {
    console.log(`Fixed: ${fixedCount} page(s) with code-fenced frontmatter auto-repaired.`);
  }

  if (broken.length === 0) {
    const totalValid = relPaths.length - codeOnlyCount;
    if (fixMode && fixedCount > 0) {
      console.log(`Valid: ${totalValid} page(s) were already clean.`);
    }
    console.log('\nAll wiki pages have valid frontmatter.');
    process.exit(0);
  }

  console.log(`\nBroken pages: ${broken.length}`);
  console.log('');

  // Count by error category
  let codeFenceCount = 0;
  let fieldErrorCount = 0;

  for (const report of broken) {
    if (report.hasCodeFence) codeFenceCount++;
    const hasFieldErrors = report.errors.some((e) => e.field !== 'raw');
    if (hasFieldErrors) fieldErrorCount++;
  }

  if (codeFenceCount > 0) {
    console.log(`  • ${codeFenceCount} page(s) with code-fenced frontmatter (run --fix to auto-repair)`);
  }
  if (fieldErrorCount > 0) {
    console.log(`  • ${fieldErrorCount} page(s) with missing/invalid fields (require manual fixes)`);
  }

  console.log('');

  for (const report of broken) {
    const prefix = report.fixed ? '✓ FIXED' : '✗ BROKEN';
    console.log(`${prefix}: ${report.relPath}`);
    for (const err of report.errors) {
      console.log(`    [${err.field}] ${err.message}`);
    }
    console.log('');
  }

  console.log(`Total broken: ${broken.length} / ${relPaths.length} page(s)`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
