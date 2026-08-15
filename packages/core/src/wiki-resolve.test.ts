/**
 * Golden set for the canonical wikilink resolver.
 *
 * This is eval set #1 of the wiki-pipeline design (2026-08-14). A deterministic
 * checker with false positives is a bug, not a tuning knob, so the bar here is
 * 100% — unlike the model-judged sets, which carry confidence intervals.
 *
 * EVERY CASE IS REAL. The corpus is a verbatim snapshot of the page inventory
 * of Clay's wiki (336 pages: path, H1, headings, declared aliases) taken
 * 2026-08-14, and every link case below was observed on that wiki at the
 * `page:line` cited beside it. Nothing here is invented. Cases were harvested by
 * resolving all live links and sampling each resolution tier and failure class,
 * so the set covers what the wiki actually contains rather than what a resolver
 * author imagined.
 *
 * That method has already paid for itself twice. It caught the slug tier
 * (display-name links never matching kebab-case filenames, 23 occurrences on one
 * page) and then the alias tier (~20 links reported as missing pages that in
 * fact exist under a declared alias) — the second of which would have made the
 * gardener create duplicate pages for people the wiki already had.
 *
 * The corpus is pinned rather than read live so the suite stays hermetic and
 * does not change meaning when Clay edits a page.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  analyzeLinks,
  buildResolveIndexFromMeta,
  extractAliases,
  extractHeadings,
  extractTitleFromBody,
  maskNonProse,
  normalizeHeading,
  normalizePath,
  parseWikilinks,
  resolveWikilink,
  slugify,
  type ResolutionStatus,
  type ResolveIndex,
  type WikiPageInput,
} from "./wiki-resolve.js";

// ---------------------------------------------------------------------------
// Real corpus
// ---------------------------------------------------------------------------

interface InventoryEntry {
  readonly rel: string;
  readonly title: string;
  readonly headings: readonly string[];
  readonly aliases: readonly string[];
}

const INVENTORY: InventoryEntry[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("./__fixtures__/wiki-inventory-2026-08-14.json", import.meta.url)), "utf8"),
) as InventoryEntry[];

/**
 * The snapshot stores each real page's H1, headings and declared aliases rather
 * than its full body — bodies run to megabytes and carry Clay's private
 * content, and these are the only properties the resolver consumes.
 */
const index: ResolveIndex = buildResolveIndexFromMeta(INVENTORY);

/** Body-shaped view of the same real pages, for the whole-corpus graph checks. */
const CORPUS: WikiPageInput[] = INVENTORY.map((p) => ({
  rel: p.rel,
  text: [
    "---",
    ...(p.aliases.length > 0 ? ["aliases:", ...p.aliases.map((a) => `  - ${a}`)] : []),
    "---",
    "",
    `# ${p.title}`,
    "",
    ...p.headings.map((h) => `## ${h}`),
  ].join("\n"),
}));

/** Resolve a link exactly as it appears on a real page. */
function resolve(fromRel: string, linkText: string) {
  const links = parseWikilinks(linkText);
  expect(links, `expected exactly one link in ${linkText}`).toHaveLength(1);
  return resolveWikilink(index, fromRel, links[0]!);
}

// ---------------------------------------------------------------------------
// Resolution tiers — one real case per tier
// ---------------------------------------------------------------------------

interface Case {
  readonly at: string;
  readonly link: string;
  readonly status: ResolutionStatus;
  readonly target: string | null;
  readonly why: string;
}

const RESOLVED_CASES: readonly Case[] = [
  {
    at: "companies/locusview.md:26",
    link: "[[interviews/locusview-head-of-product]]",
    status: "resolved",
    target: "interviews/locusview-head-of-product.md",
    why: "full path; the dream resolved titles only, so every path-style link like this was 'broken' — the mechanism behind its 329 findings vs the lint path's 96",
  },
  {
    at: "AUDIT_2026-04-16.md:172",
    link: "[[LineVision]]",
    status: "resolved",
    target: "companies/linevision.md",
    why: "bare filename stem",
  },
  {
    at: "AUDIT_2026-04-16.md:15",
    link: "[[Clay Waters]]",
    status: "resolved",
    target: "people/clay-waters.md",
    why: "H1 title",
  },
  {
    at: "companies/samsara.md:69",
    link: "[[Taylor Angevine]]",
    status: "resolved",
    target: "people/taylor-angevine.md",
    why: "display name vs kebab-case filename. 23 live occurrences failed here, and because they failed, people/taylor-angevine.md was ALSO reported as an orphan — one resolver gap manufacturing two contradictory findings about the same page",
  },
  {
    at: "companies/enel.md:45",
    link: "[[Thomas Riedl]]",
    status: "resolved",
    target: "people/thomas-riedl.md",
    why: "same slug gap, 14 live occurrences; its H1 is a role, not the person's name, so the title tier could not save it either",
  },
  {
    at: "interviews/locusview-head-of-product.md:87",
    link: "[[linevision|LineVision]]",
    status: "resolved",
    target: "companies/linevision.md",
    why: "piped alias over a stem",
  },
  {
    at: "people/taylor-angevine.md:16",
    link: "[[Samsara Interview Loop — Principal PM, Agent Platform|Samsara Principal PM – Agent Platform]]",
    status: "resolved",
    target: "interviews/samsara-loop.md",
    why: "piped alias over a title containing an em dash",
  },
  {
    at: "interviews/zapier-sdk-kei.md:105",
    link: "[[#What Clay demoed (the AI-fluency half)]]",
    status: "resolved",
    target: "interviews/zapier-sdk-kei.md",
    why: "same-page anchor. 58 of the lint path's 96 findings were this class, every one a false positive",
  },
  {
    at: "projects/plumb-email-to-wiki-review-architecture.md:34",
    link: "[[#Shipped to Production (2026-08-10, Claude Code session)|Shipped to Production]]",
    status: "resolved",
    target: "projects/plumb-email-to-wiki-review-architecture.md",
    why: "same-page anchor carrying an alias and punctuation",
  },
];

describe("resolution tiers, on real links", () => {
  for (const c of RESOLVED_CASES) {
    it(`${c.at}  ${c.link}`, () => {
      const res = resolve(c.at.split(":")[0] as string, c.link);
      expect(res.status, c.why).toBe(c.status);
      expect(res.targetRel, c.why).toBe(c.target);
    });
  }
});

// ---------------------------------------------------------------------------
// Frontmatter aliases
// ---------------------------------------------------------------------------

/**
 * 22 real pages declare `aliases:`, and this is how most cross-references
 * actually reach their target. The tier was missing from the first cut of this
 * resolver, which reported ~20 live links as pointing at pages that do not
 * exist — and under the approved auto-create policy the gardener would have
 * created duplicates of people and concepts the wiki already had.
 */
describe("alias resolution, on real links", () => {
  const ALIAS_CASES: readonly Case[] = [
    {
      at: "companies/augury.md:16",
      link: "[[Clay]]",
      status: "resolved",
      target: "people/clay-waters.md",
      why: "people/clay-waters.md declares aliases: [Clay, Clay W, David Clayton Waters]",
    },
    {
      at: "people/harper-waters.md:27",
      link: "[[Sandra Waters]]",
      status: "resolved",
      target: "people/sandra.md",
      why: "people/sandra.md declares Sandra Mumanachit, Sandra Waters and Sandra M — one person, three names",
    },
    {
      at: "companies/5280cpa.md:20",
      link: "[[Sandra Mumanachit]]",
      status: "resolved",
      target: "people/sandra.md",
      why: "same page reached by a different declared alias",
    },
    {
      at: "concepts/gemini-31-pro.md:29",
      link: "[[O3]]",
      status: "resolved",
      target: "concepts/openai-o3.md",
      why: "inline flow form, aliases: [O3]",
    },
    {
      at: "projects/plumb-20.md:47",
      link: "[[Sonnet]]",
      status: "resolved",
      target: "tools/anthropic.md",
      why: "inline flow form with two entries, aliases: [Sonnet, Claude Sonnet]",
    },
    {
      at: "companies/enernoc-labs.md:30",
      link: "[[VUFE]]",
      status: "resolved",
      target: "concepts/vufe-methodology.md",
      why: "an acronym alias for a page titled by its full name",
    },
    {
      at: "people/tiff-daley.md:28",
      link: "[[Anna Marie]]",
      status: "resolved",
      target: "people/anna-marie-clifton.md",
      why: "first name only, declared as an alias",
    },
    {
      at: "projects/agent-studio.md:48",
      link: "[[Dispatch Copilot]]",
      status: "resolved",
      target: "projects/dispatch-exception-resolution-agent.md",
      why: "a product nickname aliasing a page named for its function",
    },
    {
      at: "concepts/google-docs-api.md:61",
      link: "[[apply-jobs Skill]]",
      status: "resolved",
      target: "projects/apply-jobs.md",
      why: "block-sequence alias form",
    },
    {
      at: "concepts/nucbox-g3-plus.md:48",
      link: "[[RAG Memory System]]",
      status: "resolved",
      target: "concepts/rag.md",
      why: "a descriptive alias on a two-letter-acronym page",
    },
  ];

  for (const c of ALIAS_CASES) {
    it(`${c.at}  ${c.link}`, () => {
      const res = resolve(c.at.split(":")[0] as string, c.link);
      expect(res.status, c.why).toBe(c.status);
      expect(res.targetRel, c.why).toBe(c.target);
    });
  }

  it("concepts/notion-api.md:54  [[Job Search]] — two pages claim the same alias", () => {
    // A real collision the alias tier surfaces rather than hides.
    const res = resolve("concepts/notion-api.md", "[[Job Search]]");
    expect(res.status).toBe("ambiguous");
    expect(res.candidates).toEqual([
      "projects/clay-waters-job-search.md",
      "projects/job-search-pipeline.md",
    ]);
  });

  it("reads both YAML forms found in the wild", () => {
    expect(extractAliases(["---", "aliases: [Sonnet, Claude Sonnet]", "---"].join("\n"))).toEqual([
      "Sonnet",
      "Claude Sonnet",
    ]);
    expect(extractAliases(["---", "aliases:", "  - Clay", "  - Clay W", "---"].join("\n"))).toEqual([
      "Clay",
      "Clay W",
    ]);
  });

  it("degrades to no aliases rather than throwing on a page with no frontmatter", () => {
    // A whole-wiki scan must never die on one malformed page.
    expect(extractAliases("# Just a heading\n\nbody")).toEqual([]);
    expect(extractAliases("---\naliases:\n---")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Failure classes — kept distinct because each has a different remedy
// ---------------------------------------------------------------------------

describe("failure classes, on real links", () => {
  it("people/anthony-meaney.md:14  [[Itron]] — genuinely missing page", () => {
    // The class that is actually actionable: no such page exists. After the
    // alias tier landed, only 9 links on the whole wiki are in this class, and
    // they are the page-creation backlog rather than lint noise.
    const res = resolve("people/anthony-meaney.md", "[[Itron]]");
    expect(res.status).toBe("unresolved");
    expect(res.targetRel).toBeNull();
  });

  it("companies/linevision.md:120  [[Gather AI]] — genuinely missing page", () => {
    expect(resolve("companies/linevision.md", "[[Gather AI]]").status).toBe("unresolved");
  });

  it("tools/claude-code.md:126  [[external-communications]] — a skill, not a page", () => {
    expect(resolve("tools/claude-code.md", "[[external-communications]]").status).toBe("unresolved");
  });

  it("index.md:14  [[Anthropic]] — ambiguous, not silently first-wins", () => {
    // Two real pages answer to this name. The dream picked the first and made
    // the second permanently unreachable and therefore a permanent orphan.
    const res = resolve("index.md", "[[Anthropic]]");
    expect(res.status).toBe("ambiguous");
    expect(res.candidates).toEqual(["companies/anthropic.md", "tools/anthropic.md"]);
    expect(res.targetRel).toBeNull();
  });

  it("companies/supabase.md:40  [[Fly.io]] — ambiguous across companies/ and tools/", () => {
    expect(resolve("companies/supabase.md", "[[Fly.io]]").candidates).toEqual([
      "companies/flyio.md",
      "tools/fly-io.md",
    ]);
  });

  it("plumb-email-to-wiki-review-architecture.md:72 — page fine, heading renamed", () => {
    // The heading was later retitled to include ', Claude Code session'. This is
    // a real defect but a different one from a missing page, and conflating the
    // two is why the old report was unactionable.
    const res = resolve(
      "projects/plumb-email-to-wiki-review-architecture.md",
      "[[#Extractor Eval Results and Model Selection (2026-08-09)|Extractor Eval Results and Model Selection]]",
    );
    expect(res.status).toBe("anchor-missing");
    expect(res.targetRel).toBe("projects/plumb-email-to-wiki-review-architecture.md");
  });
});

// ---------------------------------------------------------------------------
// Masking — real prose, quoted verbatim
// ---------------------------------------------------------------------------

describe("non-prose masking, on real prose", () => {
  it("projects/plumb-benchmark-milestones.md:214 — backticked link in prose about links", () => {
    const real =
      "follow the wiki's existing `[[wikilink]]` graph one hop out from (at minimum) the top-ranked result";
    expect(parseWikilinks(real)).toEqual([]);
  });

  it("tools/claude-code.md:57 — the convention invented to dodge the old linter", () => {
    // This sentence documents a hand-made linking rule whose stated purpose is
    // avoiding "a permanent false broken-link alarm in `plumb wiki dream-lint`".
    // The wiki had started routing around its own linter; masking removes the
    // reason the convention existed.
    const real =
      "summaries link to transcripts with relative markdown links, never `[[wikilinks]]` — a wikilink resolves through `wiki_pages`";
    expect(parseWikilinks(real)).toEqual([]);
  });

  it("keeps line numbers correct across masked regions", () => {
    const real = ["```json", '{"a": 1}', "```", "", "See [[companies/linevision]]."].join("\n");
    const [link] = parseWikilinks(real);
    expect(link!.line).toBe(5);
  });

  it("never changes the length of the text it masks", () => {
    for (const page of CORPUS.slice(0, 50)) {
      expect(maskNonProse(page.text)).toHaveLength(page.text.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Normalization primitives
// ---------------------------------------------------------------------------

describe("normalization, against real page names", () => {
  it("strips extension, ./ prefix and case from a real path", () => {
    expect(normalizePath("./Projects/Terra-Chat-Architecture-Approach.MD")).toBe(
      "projects/terra-chat-architecture-approach",
    );
  });

  it("slugifies a real display name onto its real filename", () => {
    expect(slugify("Taylor Angevine")).toBe(slugify("taylor-angevine"));
    expect(slugify("Fly.io")).toBe("fly-io");
  });

  it("normalizes a real heading loosely enough to match Obsidian", () => {
    // projects/plumb-email-to-wiki-review-architecture.md carries this heading.
    expect(normalizeHeading("**Cost** (as of `2026-08-09`)")).toBe("cost (as of 2026-08-09)");
  });

  it("real em-dash headings survive normalization", () => {
    expect(normalizeHeading("SDK product state, per Kei — the most valuable intel from the call")).toBe(
      "sdk product state, per kei — the most valuable intel from the call",
    );
  });
});

describe("title and heading extraction", () => {
  it("takes the H1, not a '#' line inside frontmatter", () => {
    const real = ["---", "type: person", "summary: |", "  # a hash inside a block scalar", "---", "", "# Karthik"].join(
      "\n",
    );
    expect(extractTitleFromBody(real, "people/karthik.md")).toBe("Karthik");
  });

  it("falls back to the filename stem when a real page has no H1", () => {
    expect(extractTitleFromBody("no heading here", "people/dan-lake.md")).toBe("dan-lake");
  });

  it("ignores headings inside fenced code", () => {
    expect(extractHeadings(["# A", "```", "## Not A Heading", "```", "### C"].join("\n"))).toEqual(["A", "C"]);
  });
});

// ---------------------------------------------------------------------------
// Whole-corpus invariants
// ---------------------------------------------------------------------------

describe("whole-corpus invariants", () => {
  const GENERATED = [
    "index.md",
    "log.md",
    "REVIEW.md",
    "SCHEMA.md",
    "AUDIT_2026-04-16.md",
    "EVAL_2026-04-16.md",
    ...INVENTORY.map((p) => p.rel).filter((r) => r.endsWith("_index.md")),
  ];
  const result = analyzeLinks(CORPUS, { generatedPages: GENERATED });

  it("a page that receives real inbound links is never also an orphan", () => {
    // The invariant the slug gap violated: Taylor's page was linked 23 times
    // and reported orphaned simultaneously.
    for (const [rel, sources] of result.inbound) {
      if (sources.length > 0) expect(result.orphans).not.toContain(rel);
    }
  });

  it("no page is ever credited as linking to itself", () => {
    for (const [rel, sources] of result.inbound) expect(sources).not.toContain(rel);
  });

  it("inbound and outbound describe the same edge set", () => {
    const edges = (m: ReadonlyMap<string, readonly string[]>, flip: boolean) =>
      new Set([...m].flatMap(([k, vs]) => vs.map((v) => (flip ? `${k}->${v}` : `${v}->${k}`))));
    expect(edges(result.inbound, false)).toEqual(edges(result.outbound, true));
  });

  it("every finding names a page that exists in the corpus", () => {
    const known = new Set(INVENTORY.map((p) => p.rel));
    for (const f of result.findings) expect(known).toContain(f.page);
  });

  it("resolution is stable: re-running yields identical findings", () => {
    const again = analyzeLinks(CORPUS, { generatedPages: GENERATED });
    expect(again.findings).toEqual(result.findings);
    expect(again.orphans).toEqual(result.orphans);
  });
});
