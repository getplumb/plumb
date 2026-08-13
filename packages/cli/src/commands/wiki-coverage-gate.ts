/**
 * wiki-coverage-gate.ts — CLI command: plumb wiki coverage-gate
 *
 * Deterministic, no-model check that `wiki_pages` and the wiki tree on disk
 * agree with each other. See packages/core/src/wiki-coverage.ts for the
 * checks and the incident that motivated them (2026-08-12: wiki_pages held
 * 301 rows against 326 pages on disk for three days, silently).
 *
 * Exit code is the contract for the scheduled-jobs registry: 0 means disk and
 * index agree, 1 means they don't. --json is for machine consumption;
 * without it a human-readable report prints to stdout either way.
 *
 * Usage:
 *   plumb wiki coverage-gate [--wiki <path>] [--db <path>] [--json] [--remediate]
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { checkWikiCoverage, remediateWikiCoverage, pruneWikiGhosts } from '@getplumb/core';
import type { WikiCoverageReport, WikiCoverageRemediation, PruneResult } from '@getplumb/core';

export interface WikiCoverageGateOptions {
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** Path to wiki.db. Defaults to ~/.plumb/wiki.db */
  db?: string;
  /** Print machine-readable JSON instead of the human report. */
  json?: boolean;
  /**
   * Additive-only self-healing (WI-2): re-index missing and stale pages, then
   * backfill any surviving contextual gap, then re-check. Never deletes a
   * row, so ghosts still fail the gate and still need a human.
   */
  remediate?: boolean;
  /**
   * Delete index rows for pages that no longer belong in the index (ghosts).
   * Opt-in and never run from the scheduled job: an exclusion-rule mistake is
   * indistinguishable from a legitimate removal, so a human decides.
   */
  prune?: boolean;
  /** Bypass the prune blast-radius guardrail. */
  force?: boolean;
}

function printReport(report: WikiCoverageReport): void {
  console.log('Wiki coverage gate');
  console.log(`  wiki: ${report.wikiRoot}`);
  console.log(`  db:   ${report.dbPath}`);
  console.log(`  disk pages (post-exclusion): ${report.diskCount}`);
  console.log(`  indexed pages:               ${report.indexedCount}`);
  console.log(
    `  chunks: ${report.chunkCount}  contextual: ${report.contextualCount}  gap: ${report.embeddingGap}`,
  );
  console.log('');

  if (report.missing.length > 0) {
    console.log(`MISSING — on disk, no wiki_pages row (${report.missing.length}):`);
    for (const p of report.missing) console.log(`  - ${p}`);
    console.log('');
  }
  if (report.stale.length > 0) {
    console.log(`STALE — indexed, but the file has changed since (${report.stale.length}):`);
    for (const p of report.stale) console.log(`  - ${p}`);
    console.log('');
  }
  if (report.ghostsDeleted.length > 0) {
    console.log(`GHOSTS (file deleted) — wiki_pages row, no file on disk (${report.ghostsDeleted.length}):`);
    for (const p of report.ghostsDeleted) console.log(`  - ${p}`);
    console.log('');
  }
  if (report.ghostsExcluded.length > 0) {
    console.log(
      `GHOSTS (now excluded) — wiki_pages row, file exists but matches an exclusion rule (${report.ghostsExcluded.length}):`,
    );
    for (const p of report.ghostsExcluded) console.log(`  - ${p}`);
    console.log('');
  }
  if (report.embeddingGap !== 0) {
    console.log(
      `EMBEDDING GAP — wiki_chunks (${report.chunkCount}) != wiki_chunk_context_embeddings (${report.contextualCount})`,
    );
    console.log('');
  }

  console.log(report.ok ? 'PASS: index and disk agree.' : 'FAIL: see findings above.');
}

/**
 * What remediation actually did. Printed even on a fully successful run: a
 * self-healing job that heals silently turns "the wiki drifts constantly" and
 * "the wiki never drifts" into the same green row, which is how the original
 * outage stayed invisible for three days.
 */
function printRemediation(r: WikiCoverageRemediation): void {
  if (!r.healed) {
    console.log('Remediation: nothing to do.\n');
    return;
  }
  console.log('Remediation ran:');
  if (r.embed.ran && r.embed.stats) {
    const s = r.embed.stats;
    console.log(`  re-indexed ${r.targeted.length} page(s): ${r.targeted.join(', ')}`);
    console.log(`  embed pass: embedded=${s.embedded} skipped=${s.skipped} errors=${s.errors} chunks=${s.chunks}`);
  }
  if (r.contextual.ran && r.contextual.stats) {
    const s = r.contextual.stats;
    console.log(`  contextual backfill: embedded=${s.embedded} failed=${s.failed} coverage=${(s.coverageRatio * 100).toFixed(1)}%`);
  }
  console.log('');
}

function printPrune(p: PruneResult): void {
  if (p.refused) {
    console.log(`Prune REFUSED: ${p.reason}`);
    console.log(`  candidates (${p.candidates.length}): ${p.candidates.join(', ')}\n`);
    return;
  }
  if (p.pruned.length === 0) {
    console.log('Prune: no ghost rows to remove.\n');
    return;
  }
  console.log(`Pruned ${p.pruned.length} ghost row(s) (index rows only; no files touched):`);
  for (const path of p.pruned) console.log(`  - ${path}`);
  console.log('');
}

export async function wikiCoverageGateCommand(options: WikiCoverageGateOptions = {}): Promise<void> {
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');
  const dbPath = options.db ?? join(homedir(), '.plumb', 'wiki.db');

  let report: WikiCoverageReport;
  let remediation: WikiCoverageRemediation | null = null;
  let prune: PruneResult | null = null;

  // Prune first: it removes rows, and remediation adds them. Running the
  // additive pass first would re-embed a page that is about to be pruned.
  if (options.prune) {
    prune = await pruneWikiGhosts({
      wikiRoot,
      dbPath,
      ...(options.force === undefined ? {} : { force: options.force }),
    });
  }

  if (options.remediate) {
    remediation = await remediateWikiCoverage({ wikiRoot, dbPath });
    report = remediation.after;
  } else {
    report = await checkWikiCoverage({ wikiRoot, dbPath });
  }

  if (options.json) {
    console.log(JSON.stringify({
      ...report,
      ...(prune ? { prune } : {}),
      ...(remediation ? { remediation } : {}),
    }, null, 2));
  } else {
    if (prune) printPrune(prune);
    if (remediation) printRemediation(remediation);
    printReport(report);
  }

  process.exit(report.ok ? 0 : 1);
}
