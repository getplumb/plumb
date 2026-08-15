/**
 * wiki-fanout.ts — deciding which OTHER pages a single queued fact should touch.
 *
 * WHY THIS EXISTS
 * ---------------
 * `plumb_wiki_queue_edit` takes a bare `fact` string with no page list, and the
 * queue worker's prompt says "find the right page ... the best existing
 * canonical page". One fact, one page, always — and that constraint lives in
 * prose, not in a schema, so nothing ever measured it. Clay suspected this was
 * wrong before anyone looked; he was right, and the location of the bug was the
 * prompt.
 *
 * The nightly dream found the concrete failure on 2026-08-14: Karthik's
 * LineVision title was stale on BOTH `people/karthik.md` and
 * `companies/linevision.md`, and the dream could do nothing but send an email
 * about it. `companies/linevision.md:105` carries the sentence "[[Joe]],
 * [[Kristine]], and [[Tica]] were true peers of Clay's, alongside [[Karthik]]
 * (VP of Customer Success, while Clay was Head of Product Management)" — a title
 * claim about Karthik living on a page that is not Karthik's.
 *
 * That is not an accident of this one fact. It follows from how the wiki has to
 * work: chunk-level retrieval means a page that only says "see [[Karthik]]"
 * retrieves as useless, so the same claim deliberately lives in several places.
 * Redundancy is required, which makes propagation a first-class obligation
 * rather than a tidiness problem.
 *
 * WHY INBOUND LINKS ARE THE PROPAGATION INDEX
 * -------------------------------------------
 * A page that repeats a claim about an entity nearly always links to that
 * entity — that is what a wikilink is for. `wiki_links` is therefore the cheap,
 * already-maintained index of "who else talks about this". Measured on the live
 * wiki 2026-08-14, `people/karthik.md` has 10 inbound pages, and
 * `companies/linevision.md` — the exact page the dream flagged — is one of them.
 *
 * This only became usable on 2026-08-14. Before that `wiki_links` had been
 * frozen since 2026-08-03 (nothing in the cron set maintained it) and its
 * resolver matched on exact lowercased H1 title only, so the graph was both
 * stale and lossy. Both were fixed in Phase 0; fan-out is the reason that
 * mattered.
 *
 * Search hits are unioned in because they catch the case inbound links cannot:
 * a page that discusses the entity without ever linking to it.
 *
 * WHY EXCERPTS AND NOT WHOLE PAGES
 * --------------------------------
 * The gate that judges these candidates is a model call, and a model call
 * through `claude -p` costs ~6,500 tokens of harness overhead before the prompt
 * is even considered (measured 2026-08-14). Sending ten whole pages would add
 * tens of thousands more for no benefit: the question is only whether THIS page
 * makes a claim about THIS entity, and the evidence for that is the handful of
 * lines that name the entity. Extracting them here, deterministically, keeps the
 * gate prompt small and keeps the model's attention on the sentences that
 * actually decide the answer.
 *
 * Everything in this module is a pure function over data the caller has already
 * fetched, so it is testable against a real page inventory without a database.
 */

import { extractAliases, extractTitleFromBody, maskNonProse, normalizePath } from './wiki-resolve.js';
import { isGeneratedWikiPage } from './wiki-integrity.js';

/** Why a page ended up in the candidate set. Both is stronger than either. */
export type FanoutReason = 'inbound-link' | 'search-hit';

export interface FanoutExcerpt {
  /** 1-based line number on the candidate page. */
  readonly line: number;
  readonly text: string;
}

export interface FanoutCandidate {
  readonly page: string;
  readonly title: string;
  readonly reasons: readonly FanoutReason[];
  /** Position in the search results, or null when it was not a search hit. */
  readonly searchRank: number | null;
  /** Lines on this page that name the entity. Empty is allowed and meaningful. */
  readonly excerpts: readonly FanoutExcerpt[];
}

export interface FanoutResult {
  /** Pages the primary edit already wrote. Never candidates for themselves. */
  readonly entityPages: readonly string[];
  /** Every name those pages answer to: H1, declared aliases, de-kebabbed stem. */
  readonly entityNames: readonly string[];
  readonly candidates: readonly FanoutCandidate[];
  /** How many pages were considered before the cap, so the cap stays visible. */
  readonly consideredCount: number;
}

export interface FanoutPageInput {
  readonly rel: string;
  /** Whole file including frontmatter — aliases are read from it. */
  readonly text: string;
}

export interface FanoutOptions {
  /** Whole corpus, so titles and aliases can be resolved without a DB. */
  readonly corpus: readonly FanoutPageInput[];
  /** Pages the primary edit touched. */
  readonly entityPages: readonly string[];
  /** rel -> pages linking to it, straight from `wiki_links`. */
  readonly inbound: ReadonlyMap<string, readonly string[]>;
  /** Search result paths in rank order. */
  readonly searchHits?: readonly string[];
  /** Hard ceiling on candidates. Every one costs gate tokens. */
  readonly limit?: number;
  /** Excerpt lines kept per candidate. */
  readonly maxExcerptsPerPage?: number;
}

export const DEFAULT_FANOUT_LIMIT = 8;
export const DEFAULT_MAX_EXCERPTS = 6;

/**
 * Every name a page answers to, for finding mentions of it elsewhere.
 *
 * The de-kebabbed filename stem is included because it is how the wiki actually
 * files pages — `people/taylor-angevine.md` is linked as `[[Taylor Angevine]]`
 * and its H1 is a job role, not a name. That mismatch was the single largest
 * real defect Phase 0 found (23 live occurrences for one person), and a fan-out
 * that matched on H1 alone would reproduce it.
 */
export function entityNamesForPage(rel: string, text: string): string[] {
  const names = new Set<string>();
  const stem = (rel.split('/').pop() ?? rel).replace(/\.md$/i, '');
  names.add(stem.replace(/[-_]+/g, ' ').trim());
  const title = extractTitleFromBody(text, rel);
  if (title) names.add(title.trim());
  for (const alias of extractAliases(text)) {
    const trimmed = alias.trim();
    if (trimmed) names.add(trimmed);
  }
  // Very short names match everything. `[[o3]]` on a page about O3 is a real
  // alias, but a two-character substring scan over the whole wiki is noise.
  return [...names].filter((n) => n.length >= 3);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Lines on `text` that name any of `names`.
 *
 * Runs against the MASKED body, so a mention inside a fenced code block or a
 * YAML frontmatter value does not count — the same rule the resolver uses, for
 * the same reason: those are not claims about the entity. Line numbers stay
 * accurate because masking substitutes spaces rather than deleting.
 */
export function findEntityMentions(
  text: string,
  names: readonly string[],
  maxExcerpts: number = DEFAULT_MAX_EXCERPTS,
): FanoutExcerpt[] {
  if (names.length === 0) return [];
  const pattern = new RegExp(
    `(?<![A-Za-z0-9])(${names.map(escapeRegExp).join('|')})(?![A-Za-z0-9])`,
    'i',
  );
  const masked = maskNonProse(text).split('\n');
  const raw = text.split('\n');
  const out: FanoutExcerpt[] = [];
  for (let i = 0; i < masked.length && out.length < maxExcerpts; i++) {
    if (!pattern.test(masked[i] as string)) continue;
    const line = (raw[i] as string).trim();
    if (line === '') continue;
    out.push({ line: i + 1, text: line });
  }
  return out;
}

/**
 * Rank and cap the candidate set.
 *
 * Ordering, most-defensible-first:
 *   1. Both reasons — the page links to the entity AND ranks for the fact.
 *   2. Inbound link with at least one mention — it names the entity in prose.
 *   3. Everything else, search hits by rank.
 * A page that links to the entity but never names it in prose is usually a
 * `## Related` list, which is a place the claim does NOT belong; it stays a
 * candidate but sorts last, so the cap sheds it first.
 */
function scoreCandidate(c: FanoutCandidate): number {
  const linked = c.reasons.includes('inbound-link');
  const hit = c.reasons.includes('search-hit');
  const mentions = c.excerpts.length > 0;
  if (linked && hit) return 0;
  if (linked && mentions) return 1;
  if (hit) return 2;
  return 3;
}

export function collectFanoutCandidates(options: FanoutOptions): FanoutResult {
  const limit = options.limit ?? DEFAULT_FANOUT_LIMIT;
  const maxExcerpts = options.maxExcerptsPerPage ?? DEFAULT_MAX_EXCERPTS;

  const byRel = new Map<string, FanoutPageInput>();
  for (const p of options.corpus) byRel.set(normalizePath(p.rel), p);

  const entitySet = new Set(options.entityPages.map(normalizePath));

  const entityNames = new Set<string>();
  for (const rel of entitySet) {
    const p = byRel.get(rel);
    if (!p) continue;
    for (const n of entityNamesForPage(p.rel, p.text)) entityNames.add(n);
  }

  const reasons = new Map<string, Set<FanoutReason>>();
  const searchRank = new Map<string, number>();

  // The inbound map arrives keyed however the caller had it -- `wiki_links`
  // stores `people/karthik.md`, the resolver's canonical form is
  // `people/karthik`. Normalizing BOTH sides here rather than asking callers to
  // is the same rule the resolver follows, and getting it wrong is silent: the
  // lookup simply misses and fan-out reports zero candidates for a page with
  // ten inbound links, which is exactly what it did on the first run.
  const inboundByKey = new Map<string, string[]>();
  for (const [target, sources] of options.inbound) {
    const key = normalizePath(target);
    const list = inboundByKey.get(key) ?? [];
    for (const s of sources) list.push(s);
    inboundByKey.set(key, list);
  }

  for (const rel of entitySet) {
    for (const source of inboundByKey.get(rel) ?? []) {
      const key = normalizePath(source);
      if (entitySet.has(key)) continue;
      (reasons.get(key) ?? reasons.set(key, new Set()).get(key))?.add('inbound-link');
    }
  }
  (options.searchHits ?? []).forEach((hit, i) => {
    const key = normalizePath(hit);
    if (entitySet.has(key)) return;
    (reasons.get(key) ?? reasons.set(key, new Set()).get(key))?.add('search-hit');
    if (!searchRank.has(key)) searchRank.set(key, i + 1);
  });

  const candidates: FanoutCandidate[] = [];
  for (const [rel, why] of reasons) {
    // Generated pages are derivative: `index.md` and the `_index.md` tables are
    // rewritten from the pages themselves, so editing one would be undone and
    // would count as an edit nobody made.
    const p = byRel.get(rel);
    if (!p) continue;
    if (isGeneratedWikiPage(p.rel) || p.rel.endsWith('_index.md')) continue;
    candidates.push({
      page: p.rel,
      title: extractTitleFromBody(p.text, p.rel),
      reasons: [...why].sort(),
      searchRank: searchRank.get(rel) ?? null,
      excerpts: findEntityMentions(p.text, [...entityNames], maxExcerpts),
    });
  }

  candidates.sort((a, b) => {
    const s = scoreCandidate(a) - scoreCandidate(b);
    if (s !== 0) return s;
    const ra = a.searchRank ?? Number.MAX_SAFE_INTEGER;
    const rb = b.searchRank ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    if (a.excerpts.length !== b.excerpts.length) return b.excerpts.length - a.excerpts.length;
    return a.page.localeCompare(b.page);
  });

  return {
    entityPages: [...options.entityPages].sort(),
    entityNames: [...entityNames].sort(),
    candidates: candidates.slice(0, limit),
    consideredCount: candidates.length,
  };
}
