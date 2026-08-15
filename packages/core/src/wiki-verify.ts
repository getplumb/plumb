/**
 * wiki-verify.ts — the post-condition behind "the wiki is never structurally
 * broken": take a structural reading before an automated edit, take another
 * after, and report only what the edit made worse.
 *
 * WHY THIS EXISTS
 * ---------------
 * `plumb-wiki-queue-worker` hands a queued fact to a model with Read/Edit/Write
 * inside the wiki root and no human watching. Until 2026-08-14 nothing checked
 * what came back. On that day the worker created
 * `projects/company-wiki-brief.md` (from queue item c811000c, processed
 * 2026-08-14T20:55:31Z) with bold pseudo-frontmatter — `**Type:** project`,
 * `**Path:** ...` — instead of a YAML block, plus a duplicated H1. Nothing
 * stopped it and nobody noticed until a lint days later; the page had to be
 * repaired by hand. The prompt already told the model to match SCHEMA.md. The
 * lesson is that an instruction in a prompt is not a guarantee, and the only
 * thing that can be a guarantee is a deterministic check the writer must pass.
 *
 * So this module is deliberately NOT another checker. It reuses `analyzeLinks`
 * (the canonical resolver — see `wiki-resolve.ts`) and `collectWikiCorpus` /
 * `frontmatterKeysPresent` (see `wiki-integrity.ts`) and adds exactly one thing:
 * a line-number-independent identity for a finding, so two readings of the same
 * wiki can be subtracted.
 *
 * WHAT "ATTRIBUTABLE TO THIS EDIT" MEANS, AND WHY IT IS THE WHOLE CORPUS
 * ---------------------------------------------------------------------
 * Link findings are whole-corpus by nature. An edit to page A can dangle a link
 * that lives on page B — rename A's H1, drop an alias, or add a page whose name
 * collides with an existing one, and the defect surfaces somewhere else
 * entirely. The real 2026-08-14 example: adding `Claude Haiku` as an alias to
 * `tools/claude.md` collided with `concepts/claude-haiku.md` and turned
 * `concepts/openai-o3.md:31`'s `[[Claude Haiku]]` — a page nobody touched —
 * ambiguous. Scoping the comparison to the files the model wrote would miss
 * exactly that class, which is the class Clay complains about ("links get broken
 * all the time").
 *
 * So the comparison is whole-corpus and attribution is by WINDOW rather than by
 * page: the queue worker holds an exclusive `flock`, processes one item at a
 * time, and takes the "before" reading immediately before the model runs. The
 * model is the only writer in that window, and the worker independently
 * confirms it by diffing the wiki's bytes. Anything new in the "after" reading
 * is therefore this item's doing. A pre-existing finding on an unrelated page
 * appears in both readings, cancels, and cannot fail a good edit — which is the
 * scoping requirement, satisfied by subtraction rather than by filtering.
 *
 * WHAT IS DELIBERATELY NOT A FINDING HERE
 * ---------------------------------------
 * Orphans. Every newly created page is an orphan the moment it is written —
 * nothing links to it yet, and `index.md` earns no inbound credit by design (see
 * `isGeneratedWikiPage`). Counting that would revert every legitimate page
 * creation this pipeline exists to perform. Finding a new page a home is the
 * gardener's job (Tranche C), not a reason to throw the page away.
 *
 * Index/disk agreement and the chunk/contextual gap are also absent, though
 * `collectWikiIntegrity` reports them. They are guaranteed to look "broken"
 * immediately after any edit and are repaired seconds later by the worker's own
 * `coverage-gate --remediate` call. Checking them here would fail every single
 * item, including the correct ones.
 */

import { analyzeLinks } from './wiki-resolve.js';
import { collectWikiCorpus } from './wiki-integrity.js';

/** `link` covers the three resolver classes; `frontmatter` is one per missing field. */
export type StructureFindingKind = 'link' | 'frontmatter';

export interface StructureFinding {
  readonly kind: StructureFindingKind;
  /** The page carrying the defect — NOT necessarily the page that was edited. */
  readonly page: string;
  /**
   * Line-number-independent identity.
   *
   * WHY NO LINE NUMBER. Editing a page shifts every line below the edit. Keying
   * on `page:line` would make every pre-existing finding on an edited page look
   * new, so a single appended paragraph on a page that already carried one
   * broken link would revert the edit and dead-letter the fact. Measured on the
   * live wiki 2026-08-14: `log.md` aside, findings cluster on exactly the long
   * project pages this worker appends to most.
   *
   * Duplicates are preserved as repeated entries rather than deduplicated, so
   * an edit that adds a SECOND `[[Foo]]` to a page that already had one broken
   * `[[Foo]]` still registers as one new finding. The diff is a multiset
   * subtraction for that reason.
   */
  readonly key: string;
  /** One line a human can act on without opening the code. */
  readonly detail: string;
}

export interface WikiStructureSnapshot {
  readonly version: 1;
  readonly takenAt: string;
  readonly wikiRoot: string;
  readonly findings: readonly StructureFinding[];
  /** Convenience counters for logs; the findings array is the source of truth. */
  readonly totals: {
    readonly unresolved: number;
    readonly ambiguous: number;
    readonly anchorMissing: number;
    readonly frontmatter: number;
  };
}

/**
 * Field separator inside a finding key.
 *
 * Written as an ESCAPE SEQUENCE rather than as a literal character on purpose.
 * `jobs/src/lib/wiki-analysis.ts` carries a raw NUL byte typed straight into a
 * string literal as a join separator; the effect is that `file` reports the
 * source as `data` and plain `grep` silently returns nothing for every pattern
 * in it, which cost real time during the 2026-08-14 investigation. This file
 * reproduced that exact mistake while being written -- six raw NULs landed where
 * spaces were intended, and the only symptom was one confusing test failure. An
 * escape sequence is greppable, diffable and reviewable; a raw control byte is
 * none of those.
 *
 * U+001F is the ASCII unit separator, chosen because it cannot occur in a page
 * path, a link target or a frontmatter field name -- unlike a space or `|`, both
 * of which appear inside real link targets (`[[Display Name|path/page.md]]`).
 */
const KEY_SEP = "\u001f";

function linkKey(page: string, status: string, target: string, anchor: string | null): string {
  return [
    "link",
    page,
    status,
    target.trim().toLowerCase(),
    (anchor ?? "").trim().toLowerCase(),
  ].join(KEY_SEP);
}

function frontmatterKey(page: string, field: string): string {
  return ["frontmatter", page, field].join(KEY_SEP);
}

/**
 * Split a finding key back into its parts. Exported so consumers (and tests)
 * never have to know the separator, which is the kind of duplicated literal
 * that drifts.
 */
export function structureFindingKeyParts(key: string): string[] {
  return key.split(KEY_SEP);
}

/**
 * One structural reading of the wiki: every link finding and every missing
 * required frontmatter field, keyed so two readings can be subtracted.
 *
 * Read-only and DB-free on purpose. The worker calls this between a model run
 * and a reindex, when `wiki.db` is by definition behind the files; a check that
 * consulted the index would report drift the worker is about to fix anyway.
 */
export async function snapshotWikiStructure(wikiRoot: string): Promise<WikiStructureSnapshot> {
  const { corpus, generated, orphanExempt, pages } = await collectWikiCorpus(wikiRoot);
  const graph = analyzeLinks([...corpus], {
    generatedPages: [...generated],
    orphanExempt: [...orphanExempt],
  });

  const findings: StructureFinding[] = [];
  const totals = { unresolved: 0, ambiguous: 0, anchorMissing: 0, frontmatter: 0 };

  for (const f of graph.findings) {
    findings.push({
      kind: 'link',
      page: f.page,
      key: linkKey(f.page, f.status, f.target, f.anchor),
      detail:
        `[${f.status}] ${f.page}:${f.line} → [[${f.raw}]]` +
        (f.candidates.length > 0 ? ` — candidates: ${f.candidates.join(' | ')}` : ''),
    });
    if (f.status === 'unresolved') totals.unresolved++;
    else if (f.status === 'ambiguous') totals.ambiguous++;
    else totals.anchorMissing++;
  }

  for (const p of pages) {
    for (const field of p.missingFrontmatter) {
      findings.push({
        kind: 'frontmatter',
        page: p.rel,
        key: frontmatterKey(p.rel, field),
        detail: `[frontmatter] ${p.rel}: required field \`${field}\` is missing or malformed`,
      });
      totals.frontmatter++;
    }
  }

  return {
    version: 1,
    takenAt: new Date().toISOString(),
    wikiRoot,
    findings,
    totals,
  };
}

/**
 * Findings present in `after` that were not present in `before`, as a multiset
 * subtraction.
 *
 * Order-independent: `collectWikiCorpus` sorts paths and `analyzeLinks` walks
 * them in order, but nothing downstream should depend on that, and a reordering
 * must never look like a regression.
 */
export function newStructureFindings(
  before: WikiStructureSnapshot,
  after: WikiStructureSnapshot,
): StructureFinding[] {
  const remaining = new Map<string, number>();
  for (const f of before.findings) remaining.set(f.key, (remaining.get(f.key) ?? 0) + 1);

  const introduced: StructureFinding[] = [];
  for (const f of after.findings) {
    const left = remaining.get(f.key) ?? 0;
    if (left > 0) {
      remaining.set(f.key, left - 1);
      continue;
    }
    introduced.push(f);
  }
  return introduced;
}

export interface WikiVerifyResult {
  readonly ok: boolean;
  readonly newFindings: readonly StructureFinding[];
  /** Findings that vanished — an edit that FIXED something. Logged, never blocking. */
  readonly resolvedFindings: readonly StructureFinding[];
  readonly before: WikiStructureSnapshot | null;
  readonly after: WikiStructureSnapshot;
}

/**
 * Compare a fresh reading against a previous one.
 *
 * `before === null` means "no baseline yet" and is NOT a pass by accident: the
 * caller is bootstrapping and there is nothing to compare, so `ok` is true and
 * `newFindings` is empty. The queue worker never reaches the model without a
 * baseline, so this path only exists for the first snapshot of a batch.
 */
export function verifyWikiStructure(
  before: WikiStructureSnapshot | null,
  after: WikiStructureSnapshot,
): WikiVerifyResult {
  if (before === null) {
    return { ok: true, newFindings: [], resolvedFindings: [], before, after };
  }
  const newFindings = newStructureFindings(before, after);
  const resolvedFindings = newStructureFindings(after, before);
  return { ok: newFindings.length === 0, newFindings, resolvedFindings, before, after };
}
