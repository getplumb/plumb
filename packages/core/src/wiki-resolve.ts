/**
 * wiki-resolve.ts — The single canonical wikilink parser and resolver.
 *
 * WHY THIS EXISTS
 * ---------------
 * As of 2026-08-14 the wiki had THREE independent link/orphan detectors that
 * disagreed with each other and with reality:
 *
 *   - `plumb wiki dream-lint` (cli/src/commands/wiki-lint.ts) reported 96
 *     broken wikilinks. 68 of them were not broken: 58 same-page `[[#anchor]]`
 *     links it could not resolve, 4 `[[path/page.md]]` links whose files exist
 *     (it never stripped the extension), and 6 literal `` `[[wikilink]]` ``
 *     strings inside backticks in prose ABOUT wikilinks.
 *   - `jobs/src/lib/wiki-analysis.ts` (the nightly dream) reported 329, because
 *     it resolves targets ONLY against H1 titles, so every path-style link is
 *     "broken". It is a deliberate bug-for-bug characterization port of the
 *     retired Python, including a title-collision rule where the first page
 *     wins and every later page sharing an H1 is permanently an orphan.
 *   - `jobs/src/lib/weekly-report.ts` had a third orphan rule again.
 *
 * The cost was not the wrong numbers, it was the wrong behaviour downstream:
 * with ~70% false positives nobody could act on a lint report, so the ~28 real
 * broken links accumulated indefinitely, and the nightly model spent its budget
 * triaging the detectors' bugs instead of the wiki's. `tools/claude-code.md`
 * documents a hand-invented linking convention whose stated purpose is to dodge
 * "a permanent false broken-link alarm in `plumb wiki dream-lint`" — the wiki
 * had started routing around its own linter.
 *
 * Everything that needs to know whether a link resolves now calls this module,
 * so there is exactly one answer to the question.
 *
 * WHY IT MATTERS BEYOND LINTING
 * -----------------------------
 * The wikilink graph is the propagation index. When a fact changes, the pages
 * that must change with it are the search hits plus the link neighbourhood of
 * the entity page. A resolver that silently drops path-style links is not just
 * a noisy linter, it is a hole in the fan-out. Link integrity is retrieval
 * substrate, not hygiene.
 */

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedWikilink {
  /** Raw text between the brackets, before any splitting. */
  readonly raw: string;
  /** Page portion: left of `|`, before `#`. Empty for a same-page anchor. */
  readonly target: string;
  /** Heading portion after `#`, or null when the link names no heading. */
  readonly anchor: string | null;
  /** Display text after `|`, or null. */
  readonly alias: string | null;
  /** 1-based line number in the original text. */
  readonly line: number;
}

/**
 * `[[target]]`, `[[target|alias]]`, `[[target#anchor]]`, `[[#anchor]]`.
 *
 * Requires the closing `]]`, unlike the dream's `/\[\[([^\]|#]+)/g`, which
 * matched an unterminated `[[` and truncated at `#` — the mechanism by which
 * same-page anchors vanished from that detector entirely.
 */
const WIKILINK_RE = /\[\[([^\][]*?)\]\]/g;

/** ATX headings only; setext headings are not used anywhere in this wiki. */
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * Blank out regions whose contents are not markup: YAML frontmatter, fenced
 * code blocks, and inline code spans.
 *
 * Replaces them with spaces rather than deleting them so every byte offset and
 * line number in the returned string still matches the input. That is what lets
 * callers report a real line number for a finding.
 */
export function maskNonProse(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];

  let inFrontmatter = false;
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    // Frontmatter: only when `---` is the very first line of the document.
    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true;
      out.push(" ".repeat(line.length));
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === "---" || line.trim() === "...") inFrontmatter = false;
      out.push(" ".repeat(line.length));
      continue;
    }

    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      out.push(" ".repeat(line.length));
      if (fenceMatch && (fenceMatch[1] as string)[0] === fence[0] && (fenceMatch[1] as string).length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] as string;
      out.push(" ".repeat(line.length));
      continue;
    }

    out.push(maskInlineCode(line));
  }

  return out.join("\n");
}

/** Blank the interior of `` `code` `` spans, keeping length identical. */
function maskInlineCode(line: string): string {
  let result = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      result += line[i];
      i++;
      continue;
    }
    // Count the opening run length; a span closes on a run of the same length.
    let run = 0;
    while (i + run < line.length && line[i + run] === "`") run++;
    const marker = "`".repeat(run);
    const close = line.indexOf(marker, i + run);
    if (close === -1) {
      // Unterminated — treat the backticks as ordinary text.
      result += line.slice(i, i + run);
      i += run;
      continue;
    }
    result += " ".repeat(close + run - i);
    i = close + run;
  }
  return result;
}

/**
 * Extract every wikilink from a page body.
 *
 * Frontmatter, fenced code, and inline code are ignored, which is the whole of
 * the `` `[[wikilink]]` `` false-positive class.
 */
export function parseWikilinks(text: string): ParsedWikilink[] {
  const masked = maskNonProse(text);
  const out: ParsedWikilink[] = [];

  // Precompute line starts so each match can report a line without re-scanning.
  const lineStarts: number[] = [0];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "\n") lineStarts.push(i + 1);
  }
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(masked)) !== null) {
    const raw = (m[1] ?? "").trim();
    if (raw.length === 0) continue;

    const pipe = raw.indexOf("|");
    const alias = pipe === -1 ? null : raw.slice(pipe + 1).trim();
    const beforeAlias = pipe === -1 ? raw : raw.slice(0, pipe);

    const hash = beforeAlias.indexOf("#");
    const target = (hash === -1 ? beforeAlias : beforeAlias.slice(0, hash)).trim();
    const anchor = hash === -1 ? null : beforeAlias.slice(hash + 1).trim();

    if (target.length === 0 && (anchor === null || anchor.length === 0)) continue;

    out.push({ raw, target, anchor, alias, line: lineAt(m.index) });
  }

  return out;
}

/**
 * Read the `aliases:` list out of a page's YAML frontmatter.
 *
 * Aliases are a first-class naming mechanism on this wiki — 22 pages declare
 * them, and they are how most cross-references actually reach their target:
 * `[[Clay]]` → people/clay-waters.md, `[[Sandra Waters]]` → people/sandra.md,
 * `[[O3]]` → concepts/openai-o3.md, `[[Sonnet]]` → tools/anthropic.md.
 *
 * A resolver without this tier reports ~20 live links as pointing at missing
 * pages. That is not merely noisy: under the approved auto-create policy the
 * gardener would then create DUPLICATE pages for entities that already exist,
 * which is worse than the dangling link it set out to fix.
 *
 * Deliberately tolerant and dependency-free rather than delegating to
 * parseFrontmatter(), which throws on pages that have no frontmatter at all —
 * and unparseable frontmatter must degrade to "no aliases", never to a crash in
 * the middle of a whole-wiki scan. Handles both forms present in the wild:
 *
 *   aliases: [Sonnet, Claude Sonnet]
 *   aliases:
 *     - Clay
 *     - Clay W
 */
export function extractAliases(text: string): string[] {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return [];

  const out: string[] = [];
  const clean = (v: string): string => v.trim().replace(/^["']|["']$/g, "").trim();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "---" || line.trim() === "...") break;

    const m = /^aliases:\s*(.*)$/.exec(line);
    if (!m) continue;

    const inline = (m[1] ?? "").trim();
    if (inline.startsWith("[")) {
      for (const part of inline.replace(/^\[|\]$/g, "").split(",")) {
        const v = clean(part);
        if (v.length > 0) out.push(v);
      }
    } else if (inline.length > 0) {
      const v = clean(inline);
      if (v.length > 0) out.push(v);
    }

    // Block-sequence form on the following lines.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] as string;
      if (next.trim() === "---" || next.trim() === "...") break;
      const item = /^\s+-\s+(.*)$/.exec(next);
      if (!item) break;
      const v = clean(item[1] ?? "");
      if (v.length > 0) out.push(v);
    }
    break;
  }

  return out;
}

/** Headings on a page, in document order, with code fences already ignored. */
export function extractHeadings(text: string): string[] {
  const out: string[] = [];
  for (const line of maskNonProse(text).split("\n")) {
    const m = HEADING_RE.exec(line);
    if (m && m[2] !== undefined && m[2].trim().length > 0) out.push(m[2].trim());
  }
  return out;
}

/**
 * The page's H1, or its filename stem when it has none.
 *
 * Unlike the dream's `pageTitle()`, this reads the masked body, so an `# ...`
 * line inside a frontmatter block scalar can no longer beat the real heading.
 */
export function extractTitleFromBody(text: string, rel: string): string {
  for (const line of maskNonProse(text).split("\n")) {
    const m = HEADING_RE.exec(line);
    if (m && (m[1] as string).length === 1 && m[2] !== undefined && m[2].trim().length > 0) {
      return m[2].trim();
    }
  }
  const base = rel.split("/").pop() as string;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Lowercase, strip a `.md` suffix and any `./` prefix, collapse whitespace. */
export function normalizePath(value: string): string {
  let v = value.trim().replace(/\\/g, "/");
  while (v.startsWith("./")) v = v.slice(2);
  if (v.toLowerCase().endsWith(".md")) v = v.slice(0, -3);
  return v.replace(/\s+/g, " ").toLowerCase();
}

/**
 * Reduce a path or title to a slug: word characters only, joined by `-`.
 *
 * This is what closes the largest real defect class on Clay's wiki. Pages are
 * filed under kebab-case names (`people/taylor-angevine.md`) but linked by
 * display name (`[[Taylor Angevine]]`), and the H1 is often a role rather than
 * the person's name ("Samsara Principal PM – Maintenance"), so neither the stem
 * nor the title matched. On 2026-08-14 that produced 23 "broken" links to
 * Taylor's page and 14 to Thomas Riedl's — while both pages simultaneously
 * appeared on the orphan list, because the links pointing at them did not
 * resolve. One gap manufactured two contradictory findings about the same page.
 */
export function slugify(value: string): string {
  return normalizeHeading(value)
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Heading text reduced to a comparable key: markdown emphasis, backticks and
 * links stripped, punctuation-insensitive, lowercase.
 *
 * Obsidian compares heading links loosely; matching it exactly matters because
 * a stricter rule here reintroduces false "broken anchor" findings, which is
 * the failure this module exists to end.
 */
export function normalizeHeading(value: string): string {
  return value
    .trim()
    .replace(/`+/g, "")
    .replace(/\*\*|__|\*|_/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface WikiPageInput {
  /** Wiki-root-relative path, e.g. `people/karthik.md`. */
  readonly rel: string;
  readonly text: string;
}

export interface ResolveIndex {
  /** normalized rel path (no extension) -> rel */
  readonly byPath: ReadonlyMap<string, string>;
  /** normalized filename stem -> rels sharing it */
  readonly byStem: ReadonlyMap<string, readonly string[]>;
  /** normalized H1 title -> rels sharing it */
  readonly byTitle: ReadonlyMap<string, readonly string[]>;
  /** slugified stem or title -> rels sharing it; the display-name fallback */
  readonly bySlug: ReadonlyMap<string, readonly string[]>;
  /** rel -> normalized headings on that page */
  readonly headings: ReadonlyMap<string, ReadonlySet<string>>;
  readonly pages: readonly string[];
}

/**
 * The three derived properties the resolver actually consumes.
 *
 * Callers that already hold titles and headings — the `wiki_pages` table, a
 * pinned test snapshot — should build the index from these directly rather than
 * reconstructing page bodies just to have them parsed again.
 */
export interface WikiPageMeta {
  readonly rel: string;
  readonly title: string;
  /** Omit when unknown; `#anchor` targets on such a page then resolve to the page. */
  readonly headings?: readonly string[] | undefined;
  /** Frontmatter `aliases:`; the tier most cross-references actually match on. */
  readonly aliases?: readonly string[] | undefined;
}

export function buildResolveIndex(pages: Iterable<WikiPageInput>): ResolveIndex {
  const meta: WikiPageMeta[] = [];
  for (const { rel, text } of pages) {
    meta.push({
      rel,
      title: extractTitleFromBody(text, rel),
      headings: extractHeadings(text),
      aliases: extractAliases(text),
    });
  }
  return buildResolveIndexFromMeta(meta);
}

export function buildResolveIndexFromMeta(pages: Iterable<WikiPageMeta>): ResolveIndex {
  const byPath = new Map<string, string>();
  const byStem = new Map<string, string[]>();
  const byTitle = new Map<string, string[]>();
  const bySlug = new Map<string, string[]>();
  const headings = new Map<string, ReadonlySet<string>>();
  const all: string[] = [];

  const push = (map: Map<string, string[]>, key: string, rel: string): void => {
    if (key.length === 0) return;
    const list = map.get(key);
    if (list) {
      if (!list.includes(rel)) list.push(rel);
    } else map.set(key, [rel]);
  };

  for (const page of pages) {
    const rel = page.rel;
    all.push(rel);
    byPath.set(normalizePath(rel), rel);

    const base = rel.split("/").pop() as string;
    const stem = normalizePath(base);
    push(byStem, stem, rel);

    push(byTitle, normalizeHeading(page.title), rel);
    for (const alias of page.aliases ?? []) push(byTitle, normalizeHeading(alias), rel);

    // A page is reachable by the slug of its filename, its H1, or any alias,
    // since links in the wild use all three.
    push(bySlug, slugify(stem), rel);
    push(bySlug, slugify(page.title), rel);
    for (const alias of page.aliases ?? []) push(bySlug, slugify(alias), rel);

    if (page.headings !== undefined) {
      headings.set(rel, new Set(page.headings.map(normalizeHeading)));
    }
  }

  return { byPath, byStem, byTitle, bySlug, headings, pages: all };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type ResolutionStatus =
  /** Target page found, and any named heading exists on it. */
  | "resolved"
  /** No page matches the target at all. This is a real broken link. */
  | "unresolved"
  /** Several pages match by stem or title and nothing disambiguates them. */
  | "ambiguous"
  /** Page found, but it has no heading matching the `#anchor`. */
  | "anchor-missing";

export interface Resolution {
  readonly status: ResolutionStatus;
  /** Resolved page, or null when unresolved/ambiguous. */
  readonly targetRel: string | null;
  /** Populated only for `ambiguous`. */
  readonly candidates: readonly string[];
}

/**
 * Resolve one wikilink against the index.
 *
 * Order is most-specific-first, so a path always beats a coincidental title:
 *   1. same-page anchor (`[[#Heading]]`)
 *   2. full relative path, with or without `.md`, case-insensitive
 *   3. path relative to the linking page's own directory
 *   4. unique filename stem
 *   5. unique H1 title
 *
 * A title collision returns `ambiguous` rather than silently picking a winner.
 * The dream's first-page-wins rule made every later page with the same H1
 * permanently unreachable and therefore a permanent orphan; naming the
 * collision turns a silent, self-perpetuating defect into one finding a human
 * can fix once.
 */
export function resolveWikilink(
  index: ResolveIndex,
  fromRel: string,
  link: ParsedWikilink,
): Resolution {
  const checkAnchor = (rel: string): Resolution => {
    if (link.anchor === null || link.anchor.length === 0) {
      return { status: "resolved", targetRel: rel, candidates: [] };
    }
    const set = index.headings.get(rel);
    // Headings unknown for this page (the caller built the index from metadata
    // that omitted them, e.g. the wiki_pages table, which stores no headings).
    // Resolving the page is the answer that matters; claiming the anchor is
    // missing when we simply cannot see it would be a false positive, which is
    // the entire failure mode this module exists to end.
    if (set === undefined) return { status: "resolved", targetRel: rel, candidates: [] };
    if (set.has(normalizeHeading(link.anchor))) {
      return { status: "resolved", targetRel: rel, candidates: [] };
    }
    return { status: "anchor-missing", targetRel: rel, candidates: [] };
  };

  // 1. Same-page anchor.
  if (link.target.length === 0) return checkAnchor(fromRel);

  const key = normalizePath(link.target);

  // 2. Full path from the wiki root.
  const direct = index.byPath.get(key);
  if (direct !== undefined) return checkAnchor(direct);

  // 3. Path relative to the linking page's directory.
  const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  if (dir.length > 0) {
    const sibling = index.byPath.get(normalizePath(`${dir}/${link.target}`));
    if (sibling !== undefined) return checkAnchor(sibling);
  }

  // 4. Filename stem.
  const stems = index.byStem.get(key);
  if (stems && stems.length === 1) return checkAnchor(stems[0] as string);
  if (stems && stems.length > 1) {
    return { status: "ambiguous", targetRel: null, candidates: stems };
  }

  // 5. H1 title or a declared frontmatter alias.
  const titles = index.byTitle.get(normalizeHeading(link.target));
  if (titles && titles.length === 1) return checkAnchor(titles[0] as string);
  if (titles && titles.length > 1) {
    return { status: "ambiguous", targetRel: null, candidates: titles };
  }

  // 6. Slug of the display name against the slug of a filename or title.
  const slugged = index.bySlug.get(slugify(link.target));
  if (slugged && slugged.length === 1) return checkAnchor(slugged[0] as string);
  if (slugged && slugged.length > 1) {
    return { status: "ambiguous", targetRel: null, candidates: slugged };
  }

  // A "swapped pipe" tier — `[[Display Name|real/path]]`, resolving via the
  // alias side — was written and then removed on 2026-08-14. It appeared to
  // have 15 live instances on companies/zapier.md, but every one of them was a
  // legitimate declared frontmatter alias that resolved at tier 5 once the
  // alias tier existed. With no observed instances it would have been
  // speculative code carrying a synthetic test, so it is deliberately absent.
  // If such a link ever appears it surfaces as `unresolved`, which is visible.
  return { status: "unresolved", targetRel: null, candidates: [] };
}

// ---------------------------------------------------------------------------
// Whole-wiki analysis
// ---------------------------------------------------------------------------

export interface LinkFinding {
  readonly page: string;
  readonly line: number;
  readonly raw: string;
  readonly target: string;
  readonly anchor: string | null;
  readonly status: Exclude<ResolutionStatus, "resolved">;
  readonly candidates: readonly string[];
}

export interface LinkGraphResult {
  /** Every link that did not resolve cleanly, by severity class. */
  readonly findings: readonly LinkFinding[];
  /**
   * Count of unresolved links living on generated pages, which are deliberately
   * NOT findings. `log.md` alone carries hundreds of links to pages that were
   * renamed or never existed; it is an append-only historical record, so a
   * human editing it is meaningless — the fix, if any, belongs in whatever
   * writes it. Surfaced as a number so the exclusion stays visible rather than
   * becoming a silent filter.
   */
  readonly suppressedOnGeneratedPages: number;
  /** rel -> rels that link TO it (deduplicated, self-links excluded). */
  readonly inbound: ReadonlyMap<string, readonly string[]>;
  /** rel -> rels it links to (deduplicated, self-links excluded). */
  readonly outbound: ReadonlyMap<string, readonly string[]>;
  /** Pages with no inbound link from any other page. */
  readonly orphans: readonly string[];
}

/**
 * Build the full link graph in one pass.
 *
 * `linkSources` names pages whose outbound links count toward inbound totals
 * but which are themselves generated indexes — `index.md` links to nearly
 * everything, so counting it would make the orphan check meaningless. Pass the
 * generated pages here and they are excluded from the orphan result and from
 * inbound credit.
 */
export function analyzeLinks(
  pages: readonly WikiPageInput[],
  options: {
    readonly generatedPages?: readonly string[];
    /**
     * Pages that are real hand-written content but are never expected to
     * receive inbound links — raw transcripts under a `.plumbignore`, for
     * instance. Unlike `generatedPages` their own outbound links still count,
     * because a human wrote them; they are simply not orphan candidates.
     */
    readonly orphanExempt?: readonly string[];
  } = {},
): LinkGraphResult {
  const index = buildResolveIndex(pages);
  const generated = new Set((options.generatedPages ?? []).map(normalizePath));
  const orphanExempt = new Set((options.orphanExempt ?? []).map(normalizePath));

  const findings: LinkFinding[] = [];
  let suppressedOnGeneratedPages = 0;
  const inbound = new Map<string, Set<string>>();
  const outbound = new Map<string, Set<string>>();
  for (const { rel } of pages) {
    inbound.set(rel, new Set());
    outbound.set(rel, new Set());
  }

  for (const { rel, text } of pages) {
    const fromGenerated = generated.has(normalizePath(rel));
    for (const link of parseWikilinks(text)) {
      const res = resolveWikilink(index, rel, link);
      // A malformed-but-identifiable link still expresses a real edge, so it
      // counts toward inbound credit. Otherwise a page linked only by reversed
      // aliases would be reported as an orphan AND as broken links — the same
      // double-counting the slug gap used to cause.
      if (res.targetRel !== null) {
        const target = res.targetRel as string;
        if (target !== rel && !fromGenerated) {
          inbound.get(target)?.add(rel);
          outbound.get(rel)?.add(target);
        }
      }
      if (res.status !== "resolved") {
        if (fromGenerated) {
          suppressedOnGeneratedPages++;
          continue;
        }
        findings.push({
          page: rel,
          line: link.line,
          raw: link.raw,
          target: link.target,
          anchor: link.anchor,
          status: res.status,
          candidates: res.candidates,
        });
      }
    }
  }

  const orphans = pages
    .map((p) => p.rel)
    .filter((rel) => {
      const key = normalizePath(rel);
      if (generated.has(key) || orphanExempt.has(key)) return false;
      return (inbound.get(rel)?.size ?? 0) === 0;
    })
    .sort();

  const freeze = (m: Map<string, Set<string>>): Map<string, readonly string[]> =>
    new Map([...m].map(([k, v]) => [k, [...v].sort()] as const));

  return {
    findings,
    suppressedOnGeneratedPages,
    inbound: freeze(inbound),
    outbound: freeze(outbound),
    orphans,
  };
}
