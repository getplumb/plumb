#!/usr/bin/env node
/**
 * cli.ts — Plumb Wiki CLI: validate command.
 *
 * Usage:
 *   node dist/cli.js validate <wikiRoot> [--fix]
 *
 * validate: Scan all wiki pages under <wikiRoot>, report frontmatter errors.
 *   --fix   Auto-repair pages with code-fenced frontmatter (strips the fence).
 *           Only repairs the code-fence case; other errors require manual fixes.
 *
 * Exit codes:
 *   0  All pages valid (or all fixable pages were fixed with --fix)
 *   1  One or more pages have validation errors
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listWikiPages } from '@getplumb/core';
import { validateRawContent } from './frontmatter-validator.js';

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === 'validate') {
    const positional = args.filter((a) => !a.startsWith('--'));
    const wikiRoot = positional[1] ?? process.env['HOME'] + '/.plumb/wiki';
    const fixMode = args.includes('--fix');
    await runValidate(wikiRoot, fixMode);
  } else {
    console.error('Usage: plumb-wiki validate <wikiRoot> [--fix]');
    process.exit(1);
  }
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
