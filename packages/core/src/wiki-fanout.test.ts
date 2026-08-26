/**
 * Golden set for fan-out candidate discovery (B2).
 *
 * The case mirrors a real failure, with fictional entities. A nightly dream run
 * reported that Priya's Meridian Grid title was stale in two places at once and
 * could do nothing but email about it. The state it described is recoverable
 * verbatim from the wiki's own git history at commit 16cf2bc (the 2026-08-13
 * backup): `people/priya.md` line 11 and line 30 and
 * `companies/meridian-grid.md` line 105 all said "Head of Customer Success" while
 * line 22 of the same priya page already said "VP of Customer Success". The
 * excerpts below are those lines, trimmed.
 *
 * The cause was structural: queue item 390be49b carried the correct title and
 * the worker applied it to one page, because `build_prompt()` says "find the
 * right page ... the best existing canonical page". One fact, one page, always.
 *
 * What is being tested here is only the DETERMINISTIC half — that
 * `companies/meridian-grid.md` is recoverable from the inbound link graph without
 * a model call. The gate that judges the candidates is a model and is measured
 * separately, with numbers recorded in the queue worker's registry entry.
 */
import { describe, expect, it } from 'vitest';

import {
  collectFanoutCandidates,
  entityNamesForPage,
  findEntityMentions,
} from './wiki-fanout.js';

// ---------------------------------------------------------------------------
// Real corpus slice, from wiki commit 16cf2bc
// ---------------------------------------------------------------------------

const KARTHIK = `---
type: person
created: 2026-04-16
updated: 2026-08-12
tags: [former-manager, calibrix, former-colleague, meridian-grid]
confidence: high
summary: Alex's manager at Calibrix; separately, a peer leader at Meridian Grid (Head of Customer Success, while Alex was Head of Product Management).
---

# Priya

**VP of Customer Success at [[Meridian Grid]]** — while Alex was Head/Sr. Director of Product Management there.

At Meridian Grid, Priya (Head of Customer Success) and Alex (Head of Product Management) were peers, not manager-report.
`;

const LINEVISION = `---
type: company
created: 2026-04-16
updated: 2026-08-12
tags: [former-employer]
confidence: high
---

# Meridian Grid

## Key People

**Reporting relationships confirmed 2026-08-12:** [[Whitfield]] was Meridian Grid's CEO. [[Joe]], [[Nadia]], and [[Rosa]] were true peers of Alex's, alongside [[Priya]] (Head of Customer Success, while Alex was Head of Product Management).
`;

/** A page that links to Priya but makes no claim about his title. */
const ELLIOTT = `---
type: person
created: 2026-04-16
updated: 2026-08-13
tags: [reference]
confidence: high
---

# Elliott

## Related

- [[Marcus Ellery]], [[Priya]], [[Joe]] — fellow references on the current Latchkey roster
`;

const INDEX = `# Index

| [[Priya]] | Alex's manager at Calibrix. | person |
`;

const CORPUS = [
  { rel: 'people/priya.md', text: KARTHIK },
  { rel: 'companies/meridian-grid.md', text: LINEVISION },
  { rel: 'people/elliott.md', text: ELLIOTT },
  { rel: 'index.md', text: INDEX },
];

const INBOUND = new Map<string, readonly string[]>([
  // Keyed exactly as `wiki_links` stores it, WITH the `.md`, because that is
  // what the real caller passes and the mismatch was a live bug.
  ['people/priya.md', ['companies/meridian-grid.md', 'people/elliott.md', 'index.md']],
]);

describe('the 2026-08-14 Priya case (wiki commit 16cf2bc)', () => {
  it('recovers companies/meridian-grid.md from the inbound link graph alone', () => {
    const result = collectFanoutCandidates({
      corpus: CORPUS,
      entityPages: ['people/priya.md'],
      inbound: INBOUND,
    });
    const pages = result.candidates.map((c) => c.page);
    expect(pages).toContain('companies/meridian-grid.md');
    // The page whose stale line the dream named is the one carrying the claim,
    // so it must outrank the roster mention.
    expect(pages.indexOf('companies/meridian-grid.md')).toBeLessThan(pages.indexOf('people/elliott.md'));
  });

  it('hands the gate the exact stale line rather than the whole page', () => {
    const result = collectFanoutCandidates({
      corpus: CORPUS,
      entityPages: ['people/priya.md'],
      inbound: INBOUND,
    });
    const lv = result.candidates.find((c) => c.page === 'companies/meridian-grid.md');
    expect(lv?.excerpts).toHaveLength(1);
    expect(lv?.excerpts[0]?.text).toContain('Head of Customer Success');
    expect(lv?.excerpts[0]?.line).toBe(13);
  });

  it('never proposes the page that was already edited', () => {
    const result = collectFanoutCandidates({
      corpus: CORPUS,
      entityPages: ['people/priya.md'],
      inbound: INBOUND,
    });
    expect(result.candidates.map((c) => c.page)).not.toContain('people/priya.md');
  });

  it('drops generated pages, which are rewritten from the content anyway', () => {
    const result = collectFanoutCandidates({
      corpus: CORPUS,
      entityPages: ['people/priya.md'],
      inbound: INBOUND,
    });
    expect(result.candidates.map((c) => c.page)).not.toContain('index.md');
  });

  it('unions search hits that link to nothing', () => {
    const result = collectFanoutCandidates({
      corpus: [...CORPUS, { rel: 'companies/calibrix.md', text: '---\ntype: company\n---\n\n# Calibrix\n\nPriya led the team.\n' }],
      entityPages: ['people/priya.md'],
      inbound: INBOUND,
      searchHits: ['companies/calibrix.md'],
    });
    const calibrix = result.candidates.find((c) => c.page === 'companies/calibrix.md');
    expect(calibrix?.reasons).toEqual(['search-hit']);
    expect(calibrix?.searchRank).toBe(1);
  });

  it('keeps the cap visible instead of silently truncating', () => {
    const result = collectFanoutCandidates({
      corpus: CORPUS,
      entityPages: ['people/priya.md'],
      inbound: INBOUND,
      limit: 1,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.consideredCount).toBe(2); // index.md was dropped as generated
  });
});

describe('entityNamesForPage', () => {
  it('includes the de-kebabbed filename stem, which is how the wiki files pages', () => {
    // Real: people/morgan-ellis.md is linked as [[Morgan Ellis]] and its
    // H1 is a job role. 23 live occurrences; the largest defect Phase 0 found.
    const names = entityNamesForPage(
      'people/morgan-ellis.md',
      '---\ntype: person\n---\n\n# Northwind Principal PM – Maintenance\n',
    );
    expect(names).toContain('morgan ellis');
    expect(names).toContain('Northwind Principal PM – Maintenance');
  });

  it('includes declared aliases', () => {
    const names = entityNamesForPage(
      'tools/claude.md',
      '---\ntype: tool\naliases: [Claude, Sonnet, Claude Sonnet]\n---\n\n# Claude\n',
    );
    expect(names).toEqual(expect.arrayContaining(['Claude', 'Sonnet', 'Claude Sonnet']));
  });

  it('drops names too short to match without noise', () => {
    const names = entityNamesForPage(
      'concepts/openai-o3.md',
      '---\ntype: concept\naliases: [O3]\n---\n\n# OpenAI o3\n',
    );
    expect(names).not.toContain('O3');
  });
});

describe('findEntityMentions', () => {
  it('ignores mentions inside code fences and frontmatter', () => {
    const text = [
      '---',
      'summary: Priya was here',
      '---',
      '',
      '# Page',
      '',
      'Real prose about Priya.',
      '',
      '```',
      'Priya in a code block',
      '```',
    ].join('\n');
    const hits = findEntityMentions(text, ['Priya']);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(7);
  });

  it('matches on word boundaries, not substrings', () => {
    expect(findEntityMentions('Priyaeyan is someone else.\n', ['Priya'])).toEqual([]);
    expect(findEntityMentions('Talking to Priya, then.\n', ['Priya'])).toHaveLength(1);
  });

  it('honours the excerpt cap', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Line ${i} about Priya.`).join('\n');
    expect(findEntityMentions(text, ['Priya'], 3)).toHaveLength(3);
  });
});
