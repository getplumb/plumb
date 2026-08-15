/**
 * Tests for the integrity report and its thresholds.
 *
 * The threshold cases are built from the values measured on Clay's live wiki on
 * 2026-08-14 — 2 unresolved links, 0 ambiguous, 0 frontmatter issues, 320
 * indexed against 320 on disk, chunk/contextual gap 0 — and from the three
 * breaks deliberately introduced on a scratch copy that day to prove the gate
 * trips. Nothing here is an invented number.
 *
 * `frontmatterKeysPresent` carries its own case set because it exists to fix a
 * real, measured defect: `parseFrontmatter` normalizes `source_refs`, `tags`
 * and `confidence` to defaults, so a linter reading the parsed object can only
 * ever detect three of the six required fields.
 */

import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import {
  evaluateIntegrity,
  frontmatterKeysPresent,
  INTEGRITY_THRESHOLDS,
  isGeneratedWikiPage,
  type WikiIntegrityReport,
} from './wiki-integrity.js';

/** The live wiki, 2026-08-14, as `plumb wiki integrity` reported it. */
function liveReport(): Omit<WikiIntegrityReport, 'breaches' | 'ok'> {
  return {
    generatedAt: '2026-08-14T23:37:02.314Z',
    wikiRoot: '/home/openclaw-host/.plumb/wiki',
    dbPath: '/home/openclaw-host/.plumb/wiki.db',
    links: {
      unresolved: 2,
      ambiguous: 0,
      anchorMissing: 0,
      suppressedOnGeneratedPages: 215,
      findings: [],
    },
    orphans: { count: 9, pages: [] },
    frontmatter: { count: 0, issues: [] },
    index: {
      diskCount: 320,
      indexedCount: 320,
      missing: [],
      ghostsDeleted: [],
      ghostsExcluded: [],
      stale: [],
      chunkCount: 2513,
      contextualCount: 2513,
      embeddingGap: 0,
      ok: true,
    },
    linkGraph: { rows: 1400, resolved: 1398, unresolved: 2, pagesWithOutbound: 298 },
  };
}

describe('evaluateIntegrity', () => {
  test('the live wiki as measured on 2026-08-14 breaches nothing', () => {
    assert.deepEqual(evaluateIntegrity(liveReport()), []);
  });

  test('the two live unresolved links sit under the threshold on purpose', () => {
    // They are `[[Plumb Wiki Integrity]]` (a deliberate forward reference to a
    // job that does not exist yet) and `[[...]]` (prose quoting a link shape).
    // Writing a link before its page is a legitimate way to work here, so the
    // threshold has headroom rather than demanding zero.
    const r = liveReport();
    assert.ok(r.links.unresolved < INTEGRITY_THRESHOLDS.maxUnresolvedLinks);
  });

  test('crossing the unresolved-link threshold breaches, and names the backlog', () => {
    const r = liveReport();
    const breaches = evaluateIntegrity({ ...r, links: { ...r.links, unresolved: 8 } });
    assert.equal(breaches.length, 1);
    assert.equal(breaches[0]?.check, 'links.unresolved');
    assert.match(breaches[0]?.message ?? '', /page-creation backlog/);
  });

  test('a single ambiguous target breaches, because zero is the pinned value', () => {
    // Measured on a scratch copy: duplicating tools/plumb.md to concepts/plumb.md
    // made 93 live `[[Plumb]]` links ambiguous at once. One collision is never a
    // local problem, which is why this has no headroom.
    const r = liveReport();
    const breaches = evaluateIntegrity({ ...r, links: { ...r.links, ambiguous: 1 } });
    assert.equal(breaches.length, 1);
    assert.equal(breaches[0]?.check, 'links.ambiguous');
    assert.match(breaches[0]?.message ?? '', /credits NEITHER page/);
  });

  test('a single frontmatter issue breaches', () => {
    const r = liveReport();
    const breaches = evaluateIntegrity({ ...r, frontmatter: { count: 1, issues: [] } });
    assert.equal(breaches[0]?.check, 'frontmatter.count');
  });

  test('a nonzero chunk/contextual gap breaches — the 2026-08-08 signature', () => {
    const r = liveReport();
    const breaches = evaluateIntegrity({
      ...r,
      index: { ...r.index, contextualCount: 2400, embeddingGap: 113 },
    });
    assert.equal(breaches[0]?.check, 'index.embeddingGap');
    assert.match(breaches[0]?.message ?? '', /2026-08-08/);
  });

  test('index/disk disagreement breaches — the 2026-08-12 signature', () => {
    // The real outage: 301 indexed against 326 on disk, for three days.
    const r = liveReport();
    const breaches = evaluateIntegrity({
      ...r,
      index: { ...r.index, diskCount: 326, indexedCount: 301, missing: ['people/x.md'] },
    });
    const checks = breaches.map((b) => b.check);
    assert.ok(checks.includes('index.diskCount'));
    assert.ok(checks.includes('index.missing'));
  });

  test('stale index rows breach, and the message names the pages', () => {
    const r = liveReport();
    const breaches = evaluateIntegrity({
      ...r,
      index: { ...r.index, stale: ['people/karthik.md', 'projects/company-wiki-brief.md'] },
    });
    assert.equal(breaches[0]?.check, 'index.stale');
    assert.match(breaches[0]?.message ?? '', /people\/karthik\.md/);
  });

  test('orphans are NOT a breach', () => {
    // Nine stand at any given time and several are pages created this week;
    // promoting a stable background number to "action needed" is how a gate
    // trains its reader to ignore it. Reported, never gating.
    const r = liveReport();
    assert.deepEqual(evaluateIntegrity({ ...r, orphans: { count: 40, pages: [] } }), []);
  });

  test('every breach carries an observed value, a threshold and a remedy', () => {
    const r = liveReport();
    const breaches = evaluateIntegrity({
      ...r,
      links: { ...r.links, unresolved: 99, ambiguous: 3, anchorMissing: 2 },
      frontmatter: { count: 4, issues: [] },
    });
    assert.ok(breaches.length >= 4);
    for (const b of breaches) {
      assert.ok(b.check.length > 0);
      assert.notEqual(b.observed, undefined);
      assert.notEqual(b.threshold, undefined);
      assert.ok(b.message.length > 20, `${b.check} needs an actionable message`);
    }
  });
});

describe('frontmatterKeysPresent', () => {
  /**
   * people/karthik.md as it stands on the live wiki. Its `confidence: high`
   * line was stripped on a scratch copy on 2026-08-14 and the old check — which
   * read the PARSED object — did not notice, because `parseFrontmatter` fills in
   * `confidence: 'medium'` when the key is absent.
   */
  const KARTHIK = [
    '---',
    'type: person',
    'created: 2026-04-16',
    'updated: 2026-08-14',
    'source_refs:',
    '  - plumb:ad7d0123-0234-45a5-9fd1-b65ecafa7f43',
    '  - plumb:1f626de3-56c9-4278-bd1a-407905999d4b',
    'tags: [former-manager, enernoc, reference]',
    'confidence: high',
    "summary: Clay's manager at EnerNOC.",
    '---',
    '',
    '# Karthik',
  ].join('\n');

  test('reads every top-level key an author actually wrote', () => {
    const keys = frontmatterKeysPresent(KARTHIK);
    for (const k of ['type', 'created', 'updated', 'source_refs', 'tags', 'confidence', 'summary']) {
      assert.ok(keys.has(k), `expected ${k}`);
    }
  });

  test('sees the removal of confidence, which the parsed object cannot', () => {
    const stripped = KARTHIK.split('\n').filter((l) => !l.startsWith('confidence:')).join('\n');
    assert.equal(frontmatterKeysPresent(stripped).has('confidence'), false);
  });

  test('sees the removal of tags and source_refs, which default to []', () => {
    const noTags = KARTHIK.split('\n').filter((l) => !l.startsWith('tags:')).join('\n');
    assert.equal(frontmatterKeysPresent(noTags).has('tags'), false);

    const noRefs = KARTHIK.split('\n')
      .filter((l) => !l.startsWith('source_refs:') && !l.trim().startsWith('- plumb:'))
      .join('\n');
    assert.equal(frontmatterKeysPresent(noRefs).has('source_refs'), false);
  });

  test('list items and nested keys are not mistaken for top-level keys', () => {
    const keys = frontmatterKeysPresent(KARTHIK);
    assert.equal(keys.has('plumb'), false, 'a `- plumb:...` item is a value, not a key');
  });

  test('stops at the closing fence, so body headings are never counted', () => {
    const withBody = KARTHIK + '\n\nnote: this line is prose, not frontmatter\n';
    assert.equal(frontmatterKeysPresent(withBody).has('note'), false);
  });

  test('a page with no frontmatter block yields no keys rather than throwing', () => {
    assert.equal(frontmatterKeysPresent('# Just a heading\n').size, 0);
    assert.equal(frontmatterKeysPresent('').size, 0);
  });
});

describe('isGeneratedWikiPage', () => {
  test('the generated pages that must not earn inbound credit', () => {
    // log.md alone carries hundreds of links to renamed or never-created pages,
    // and index.md links to nearly the whole wiki — counting either would make
    // the orphan check meaningless.
    for (const p of ['index.md', 'log.md', '_index.md', 'REVIEW.md', 'SCHEMA.md']) {
      assert.equal(isGeneratedWikiPage(p), true, p);
    }
    assert.equal(isGeneratedWikiPage('AUDIT_2026-04-16.md'), true);
    assert.equal(isGeneratedWikiPage('EVAL_2026-04-16.md'), true);
  });

  test('real content pages are not generated, including in subdirectories', () => {
    for (const p of ['people/karthik.md', 'companies/itron.md', 'projects/plumb-benchmark.md']) {
      assert.equal(isGeneratedWikiPage(p), false, p);
    }
  });
});
