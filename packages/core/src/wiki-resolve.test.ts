/**
 * Unit suite for the canonical wikilink resolver.
 *
 * WHY THIS CORPUS IS INVENTED. Until 2026-08-21 this file ran against a
 * verbatim inventory of Clay Waters' personal wiki — 336 real pages — and that
 * fixture was staged to be published here. It named a child, a spouse, health
 * topics and salary expectations. The corpus moved to a private repository
 * (`plumb-bench`), and this suite was rewritten against a small invented one.
 *
 * The trade is deliberate and it is a real trade. Real corpora find bugs
 * invented ones do not: the original caught the slug tier (display-name links
 * never matching kebab-case filenames) and the alias tier (links reported as
 * missing that existed under a declared alias). Neither was imagined by a test
 * author — both were observed. So the private suite is still the higher-fidelity
 * half and both are expected to pass.
 *
 * What this suite owes an open-source contributor is different: the resolver's
 * contract, testable by someone with no access to anyone's private wiki. So the
 * corpus below is built to contain one instance of each thing the resolver has
 * to get right — every resolution tier, every failure class — rather than to
 * look like a real wiki.
 */
import { describe, expect, it } from "vitest";

import {
  analyzeLinks,
  buildResolveIndex,
  extractAliases,
  extractHeadings,
  extractTitleFromBody,
  maskNonProse,
  normalizeHeading,
  normalizePath,
  parseWikilinks,
  resolveWikilink,
  slugify,
  type ResolveIndex,
  type WikiPageInput,
} from "./wiki-resolve.js";

// ---------------------------------------------------------------------------
// A corpus built from the resolver's contract, one page per thing to get right
// ---------------------------------------------------------------------------

const page = (rel: string, body: string): WikiPageInput => ({ rel, text: body });

const CORPUS: WikiPageInput[] = [
  // Alias tier: one person, three names — the shape that caused ~20 links to be
  // reported as missing pages that in fact existed.
  page(
    "people/dana.md",
    `---
aliases:
  - Dana Rivera
  - Dana Mumford
  - Dana R
---

# Dana Rivera

## Overview
Links out to [[Northwind Freight]] and [[ledger-project]].
`,
  ),
  // Slug tier: a display-name link that matches no kebab-case filename.
  page("projects/ledger-project.md", "# Ledger Project\n\n## Status\nSee [[Dana Rivera]].\n"),
  // Title tier, and one half of an ambiguity: two pages share this H1.
  page("companies/northwind.md", "# Northwind\n\n## Overview\nA freight company.\n"),
  page("tools/northwind.md", "# Northwind\n\n## Overview\nA logistics tool.\n"),
  // Unambiguous title, used as the alias target above.
  page("companies/northwind-freight.md", "# Northwind Freight\n\n## Overview\nDistinct entity.\n"),
  // Anchors: one heading that exists, and the page linked at a renamed one.
  page("concepts/retrieval.md", "# Retrieval\n\n## Scoring\n## Chunking\n"),
  // No H1 at all: title falls back to the filename stem.
  page("notes/untitled-note.md", "Just a body, no heading at all.\n"),
  // A '#' inside frontmatter must not be mistaken for the H1.
  page(
    "notes/frontmatter-hash.md",
    `---
summary: "# not a heading"
---

# Real Title

## Section
`,
  ),
  // Headings inside a fenced block are not headings.
  page(
    "notes/fenced.md",
    "# Fenced\n\n```md\n## Not A Heading\n[[Not A Link]]\n```\n\n## Actually A Heading\n",
  ),
  // Prose about links, where the link is backticked and so is not a link.
  page("notes/prose.md", "# Prose\n\nWriting `[[Dana Rivera]]` inline shows the syntax.\n"),
  // The failure classes.
  page("notes/broken.md", "# Broken\n\nLinks to [[No Such Page]] and [[Northwind]].\n"),
  page("notes/anchored.md", "# Anchored\n\nSee [[Retrieval#Scoring]] and [[Retrieval#Renamed Away]].\n"),
];

const index: ResolveIndex = buildResolveIndex(CORPUS);

/** Resolve a link exactly as it would appear on a page. */
function resolve(fromRel: string, linkText: string) {
  const links = parseWikilinks(linkText);
  expect(links, `expected exactly one link in ${linkText}`).toHaveLength(1);
  return resolveWikilink(index, fromRel, links[0]!);
}

// ---------------------------------------------------------------------------

describe("resolution tiers", () => {
  it("resolves by exact path", () => {
    expect(resolve("notes/prose.md", "[[people/dana.md]]").targetRel).toBe("people/dana.md");
  });

  it("resolves by path without the extension", () => {
    expect(resolve("notes/prose.md", "[[people/dana]]").targetRel).toBe("people/dana.md");
  });

  it("resolves by filename stem alone", () => {
    expect(resolve("notes/prose.md", "[[dana]]").targetRel).toBe("people/dana.md");
  });

  it("resolves by H1 title", () => {
    expect(resolve("notes/prose.md", "[[Retrieval]]").targetRel).toBe("concepts/retrieval.md");
  });

  it("resolves a display name onto its kebab-case filename via the slug tier", () => {
    // The tier that 23 links on one real page depended on.
    expect(resolve("notes/prose.md", "[[Ledger Project]]").targetRel)
      .toBe("projects/ledger-project.md");
  });

  it("resolves through a declared alias", () => {
    expect(resolve("notes/prose.md", "[[Dana Mumford]]").targetRel).toBe("people/dana.md");
  });

  it("treats every alias of one page as the same target", () => {
    for (const name of ["Dana Rivera", "Dana Mumford", "Dana R"]) {
      expect(resolve("notes/prose.md", `[[${name}]]`).targetRel).toBe("people/dana.md");
    }
  });

  it("is case- and separator-insensitive the way Obsidian is", () => {
    expect(resolve("notes/prose.md", "[[dana rivera]]").targetRel).toBe("people/dana.md");
  });
});

describe("alias parsing", () => {
  it("reads both YAML forms", () => {
    const block = extractAliases('---\naliases:\n  - One\n  - Two\n---\n# T\n');
    expect(block).toEqual(["One", "Two"]);
    const inline = extractAliases('---\naliases: [One, Two]\n---\n# T\n');
    expect(inline).toEqual(["One", "Two"]);
  });

  it("degrades to no aliases rather than throwing on a page with no frontmatter", () => {
    expect(extractAliases("# Just A Title\n")).toEqual([]);
  });
});

describe("failure classes", () => {
  it("reports a genuinely missing page as unresolved", () => {
    const res = resolve("notes/broken.md", "[[No Such Page]]");
    expect(res.status).toBe("unresolved");
    expect(res.targetRel).toBeNull();
  });

  it("reports a title claimed by two pages as ambiguous, not silently first-wins", () => {
    // The property that matters: an ambiguous link must never quietly pick one.
    const res = resolve("notes/broken.md", "[[Northwind]]");
    expect(res.status).toBe("ambiguous");
    expect(res.candidates).toEqual(
      expect.arrayContaining(["companies/northwind.md", "tools/northwind.md"]),
    );
  });

  it("resolves the page but flags a heading that no longer exists", () => {
    expect(resolve("notes/anchored.md", "[[Retrieval#Scoring]]").status).toBe("resolved");
    const renamed = resolve("notes/anchored.md", "[[Retrieval#Renamed Away]]");
    expect(renamed.status).toBe("anchor-missing");
    expect(renamed.targetRel).toBe("concepts/retrieval.md");
  });
});

describe("non-prose masking", () => {
  it("does not treat a backticked link as a link", () => {
    expect(parseWikilinks("Writing `[[Dana Rivera]]` inline shows the syntax.")).toHaveLength(0);
  });

  it("does not treat a link inside a fenced block as a link", () => {
    expect(parseWikilinks("```md\n[[Not A Link]]\n```\n")).toHaveLength(0);
  });

  it("keeps line numbers correct across masked regions", () => {
    const text = "```\nfenced\n```\n\n[[Retrieval]]\n";
    expect(parseWikilinks(text)[0]!.line).toBe(5);
  });

  it("never changes the length of the text it masks", () => {
    // Offsets into the masked string must still index the original, which is
    // what lets a caller report a real line number.
    for (const text of CORPUS.map((p) => p.text)) {
      expect(maskNonProse(text)).toHaveLength(text.length);
    }
  });
});

describe("normalization", () => {
  it("strips extension, ./ prefix and case from a path", () => {
    expect(normalizePath("./People/Dana.MD")).toBe(normalizePath("people/dana"));
  });

  it("slugifies a display name onto its filename stem", () => {
    expect(slugify("Ledger Project")).toBe("ledger-project");
  });

  it("normalizes a heading loosely enough to match Obsidian", () => {
    expect(normalizeHeading("  **Scoring**  ")).toBe(normalizeHeading("Scoring"));
  });

  it("survives em-dashes in headings", () => {
    expect(normalizeHeading("Retrieval — Scoring")).toBe(normalizeHeading("Retrieval — Scoring"));
    expect(normalizeHeading("A  —  B")).toBe("a — b");
  });
});

describe("title and heading extraction", () => {
  it("takes the H1, not a '#' line inside frontmatter", () => {
    const body = CORPUS.find((p) => p.rel === "notes/frontmatter-hash.md")!.text;
    expect(extractTitleFromBody(body, "notes/frontmatter-hash.md")).toBe("Real Title");
  });

  it("falls back to the filename stem when a page has no H1", () => {
    const body = CORPUS.find((p) => p.rel === "notes/untitled-note.md")!.text;
    expect(extractTitleFromBody(body, "notes/untitled-note.md")).toBe("untitled-note");
  });

  it("ignores headings inside fenced code", () => {
    const body = CORPUS.find((p) => p.rel === "notes/fenced.md")!.text;
    expect(extractHeadings(body)).toContain("Actually A Heading");
    expect(extractHeadings(body)).not.toContain("Not A Heading");
  });
});

describe("whole-corpus invariants", () => {
  const graph = analyzeLinks(CORPUS);

  it("a page that receives inbound links is never also an orphan", () => {
    for (const [rel, sources] of graph.inbound) {
      if (sources.length > 0) expect(graph.orphans).not.toContain(rel);
    }
  });

  it("no page is ever credited as linking to itself", () => {
    for (const [rel, targets] of graph.outbound) expect(targets).not.toContain(rel);
  });

  it("inbound and outbound describe the same edge set", () => {
    const out = new Set<string>();
    for (const [from, targets] of graph.outbound) for (const t of targets) out.add(`${from}->${t}`);
    const inb = new Set<string>();
    for (const [to, sources] of graph.inbound) for (const s of sources) inb.add(`${s}->${to}`);
    expect([...out].sort()).toEqual([...inb].sort());
  });

  it("every finding names a page that exists in the corpus", () => {
    const rels = new Set(CORPUS.map((p) => p.rel));
    for (const f of graph.findings) expect(rels.has(f.page)).toBe(true);
  });

  it("resolution is stable: re-running yields identical findings", () => {
    expect(analyzeLinks(CORPUS).findings).toEqual(graph.findings);
  });
});
