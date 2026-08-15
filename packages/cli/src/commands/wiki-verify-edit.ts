/**
 * wiki-verify-edit.ts — CLI command: plumb wiki verify-edit
 *
 * The deterministic half of the queue worker's verify-then-commit
 * post-condition. Takes a structural reading of the wiki and, given a previous
 * reading, reports only the findings the interval introduced. See
 * `packages/core/src/wiki-verify.ts` for what counts as a finding, what is
 * deliberately excluded (orphans, index drift), and why attribution is
 * whole-corpus.
 *
 * WHY A SEPARATE COMMAND AND NOT `plumb wiki integrity`. Integrity is the
 * scheduled, DB-backed, threshold-enforcing view: it reads `wiki.db`, reports
 * index/disk agreement and the chunk/contextual gap, and writes
 * `integrity.json`. Every one of those is guaranteed to look broken in the
 * seconds between a model editing a page and the worker's `coverage-gate
 * --remediate` call, so running it as a post-condition would fail every item
 * including the correct ones. This command is file-only and comparative. Both
 * call the same `analyzeLinks` and the same `collectWikiCorpus`, so they cannot
 * disagree about whether a link resolves.
 *
 * Exit code is the contract, matching `plumb wiki integrity`:
 *   0 — no new findings (or no baseline supplied, i.e. snapshot-only mode)
 *   1 — the interval introduced at least one finding
 * Read-only. This command never edits the wiki; reverting is the caller's job,
 * because only the caller holds the pre-edit bytes.
 *
 * Usage:
 *   plumb wiki verify-edit --out before.json                  # take a baseline
 *   plumb wiki verify-edit --before before.json --out after.json --json
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import { snapshotWikiStructure, verifyWikiStructure } from '@getplumb/core';
import type { WikiStructureSnapshot, StructureFinding } from '@getplumb/core';

export interface WikiVerifyEditCommandOptions {
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** Previous snapshot to compare against. Omit to take a baseline only. */
  before?: string;
  /** Where to write the reading just taken, for reuse as the next baseline. */
  out?: string;
  /** Emit the machine-readable verdict instead of the human summary. */
  json?: boolean;
}

export async function wikiVerifyEditCommand(
  options: WikiVerifyEditCommandOptions = {},
): Promise<void> {
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');

  let before: WikiStructureSnapshot | null = null;
  if (options.before !== undefined) {
    // A missing or corrupt baseline must NOT silently degrade into "no
    // baseline, therefore pass" — that would turn every read error into a green
    // verify, which is the exact absence-equals-success failure the health
    // check was fixed for on 2026-08-14. Fail loudly instead.
    let raw: string;
    try {
      raw = readFileSync(options.before, 'utf8');
    } catch (err) {
      console.error(
        `verify-edit: cannot read baseline ${options.before} ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
      process.exit(2);
    }
    try {
      before = JSON.parse(raw) as WikiStructureSnapshot;
    } catch (err) {
      console.error(
        `verify-edit: baseline ${options.before} is not valid JSON ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
      process.exit(2);
    }
    if (before === null || before.version !== 1 || !Array.isArray(before.findings)) {
      console.error(`verify-edit: baseline ${options.before} is not a v1 structure snapshot`);
      process.exit(2);
    }
  }

  const after = await snapshotWikiStructure(wikiRoot);
  const verdict = verifyWikiStructure(before, after);

  if (options.out !== undefined) {
    mkdirSync(join(options.out, '..'), { recursive: true });
    writeFileSync(options.out, JSON.stringify(after) + '\n');
  }

  if (options.json) {
    console.log(
      JSON.stringify({
        ok: verdict.ok,
        comparedAgainst: options.before ?? null,
        newFindings: verdict.newFindings,
        resolvedFindings: verdict.resolvedFindings,
        totals: after.totals,
        snapshotWritten: options.out ?? null,
      }),
    );
  } else {
    printVerdict(verdict.ok, verdict.newFindings, verdict.resolvedFindings, after, before !== null);
  }

  process.exit(verdict.ok ? 0 : 1);
}

function printVerdict(
  ok: boolean,
  newFindings: readonly StructureFinding[],
  resolvedFindings: readonly StructureFinding[],
  after: WikiStructureSnapshot,
  compared: boolean,
): void {
  console.log('Wiki verify-edit');
  console.log(`  wiki: ${after.wikiRoot}`);
  console.log(
    `  now:  unresolved ${after.totals.unresolved}  ambiguous ${after.totals.ambiguous}  ` +
      `stale-anchor ${after.totals.anchorMissing}  frontmatter ${after.totals.frontmatter}`,
  );
  if (!compared) {
    console.log('  baseline: none supplied — snapshot only, nothing compared.');
    return;
  }
  if (resolvedFindings.length > 0) {
    console.log(`  fixed by this edit (${resolvedFindings.length}):`);
    for (const f of resolvedFindings) console.log(`    ${f.detail}`);
  }
  if (newFindings.length > 0) {
    console.log(`  INTRODUCED BY THIS EDIT (${newFindings.length}):`);
    for (const f of newFindings) console.log(`    ${f.detail}`);
  }
  console.log(ok ? 'PASS: the edit introduced no structural findings.' : 'FAIL: see above.');
}
