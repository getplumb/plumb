/**
 * wiki-integrity.ts — CLI command: plumb wiki integrity
 *
 * Computes every deterministic structural fact about the wiki in one pass,
 * writes `integrity.json`, and exits nonzero when a threshold is breached.
 * See `packages/core/src/wiki-integrity.ts` for what is measured and why each
 * threshold sits where it does.
 *
 * Exit code is the contract: 0 means no threshold breached, 1 means at least
 * one is. Read-only — this command never writes to the wiki or the index, only
 * to the artifact.
 *
 * Usage:
 *   plumb wiki integrity [--wiki <path>] [--db <path>] [--out <path>]
 *                        [--json] [--no-write]
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  collectWikiIntegrity,
  writeIntegrityReport,
  defaultIntegrityPath,
} from '@getplumb/core';
import type { WikiIntegrityReport } from '@getplumb/core';

export interface WikiIntegrityCommandOptions {
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** Path to wiki.db. Defaults to ~/.plumb/wiki.db */
  db?: string;
  /** Where to write integrity.json. Defaults to ~/.plumb/integrity.json */
  out?: string;
  /** Print the report as JSON instead of the human summary. */
  json?: boolean;
  /** Compute and report without writing the artifact. */
  noWrite?: boolean;
}

export function printIntegrity(report: WikiIntegrityReport, outPath: string | null): void {
  console.log('Wiki integrity');
  console.log(`  wiki: ${report.wikiRoot}`);
  console.log(`  db:   ${report.dbPath}`);
  console.log('');
  console.log(`  links      unresolved ${report.links.unresolved}  ambiguous ${report.links.ambiguous}  stale-anchor ${report.links.anchorMissing}`);
  console.log(`             (${report.links.suppressedOnGeneratedPages} suppressed on generated pages)`);
  console.log(`  orphans    ${report.orphans.count}`);
  console.log(`  frontmatter issues ${report.frontmatter.count}`);
  console.log(`  index      disk ${report.index.diskCount}  indexed ${report.index.indexedCount}  missing ${report.index.missing.length}  stale ${report.index.stale.length}`);
  console.log(`             chunks ${report.index.chunkCount}  contextual ${report.index.contextualCount}  gap ${report.index.embeddingGap}`);
  console.log(`  link graph ${report.linkGraph.rows} rows, ${report.linkGraph.resolved} resolved, ${report.linkGraph.unresolved} unresolved, ${report.linkGraph.pagesWithOutbound} pages with outbound edges`);
  console.log('');

  // Findings are listed even when they do not breach a threshold. A number with
  // no example behind it is a number nobody acts on, which is the failure this
  // whole redesign is about.
  if (report.links.findings.length > 0) {
    console.log(`Link findings (${report.links.findings.length}):`);
    for (const f of report.links.findings) {
      const extra = f.candidates.length > 0 ? ` — ${f.candidates.join(' | ')}` : '';
      console.log(`  [${f.status}] ${f.page}:${f.line} → [[${f.raw}]]${extra}`);
    }
    console.log('');
  }
  if (report.orphans.count > 0) {
    console.log(`Orphan pages (${report.orphans.count}):`);
    for (const p of report.orphans.pages) console.log(`  - ${p}`);
    console.log('');
  }
  if (report.frontmatter.count > 0) {
    console.log(`Frontmatter issues (${report.frontmatter.count}):`);
    for (const i of report.frontmatter.issues) {
      console.log(`  - ${i.page}: missing ${i.missing.join(', ')}`);
    }
    console.log('');
  }

  if (report.breaches.length > 0) {
    console.log(`THRESHOLD BREACHES (${report.breaches.length}):`);
    for (const b of report.breaches) {
      console.log(`  ${b.check}: ${b.observed} (threshold ${b.threshold})`);
      console.log(`    ${b.message}`);
    }
    console.log('');
  }

  if (outPath !== null) console.log(`Wrote ${outPath}`);
  console.log(report.ok ? 'PASS: no threshold breached.' : 'FAIL: see breaches above.');
}

export async function wikiIntegrityCommand(
  options: WikiIntegrityCommandOptions = {},
): Promise<void> {
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');
  const dbPath = options.db ?? join(homedir(), '.plumb', 'wiki.db');

  const report = await collectWikiIntegrity({ wikiRoot, dbPath });

  let outPath: string | null = null;
  if (options.noWrite !== true) {
    outPath = options.out ?? defaultIntegrityPath(dbPath);
    writeIntegrityReport(outPath, report);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printIntegrity(report, outPath);
  }

  process.exit(report.ok ? 0 : 1);
}
