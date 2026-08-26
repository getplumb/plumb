import { describe, it, expect } from 'vitest';
import { formatWikiBlock, shouldSkipWikiInjectionForLiveData } from './wiki-injection.js';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function result(path: string, title: string, snippet: string, section = 'Notes', chunkIndex = 0) {
  return {
    path,
    title,
    type: 'project',
    snippet,
    section,
    chunkIndex,
    score: 1,
  };
}

function contextualResult(path: string, title: string, matchedChild: string, parentContext: string, section = 'Notes', chunkIndex = 0) {
  return {
    ...result(path, title, matchedChild, section, chunkIndex),
    matchedChildSnippet: matchedChild,
    parentContext,
    retrievalSource: 'contextual' as const,
    sourceChunkId: chunkIndex + 100,
  };
}

describe('formatWikiBlock', () => {
  it('caps each parent section at 1000 characters across chunks', () => {
    const firstChunk = 'a'.repeat(800);
    const secondChunk = 'b'.repeat(800);
    const { block } = formatWikiBlock([
      result('projects/alpha.md', 'Alpha', firstChunk, 'Deep Context'),
      result('projects/alpha.md', 'Alpha', secondChunk, 'Deep Context'),
    ]);

    const snippetLines = block
      .split('\n')
      .filter((line) => line.startsWith('   '))
      .map((line) => line.trim());

    expect(snippetLines.join('').length).toBe(1000);
    expect(snippetLines[0]).toHaveLength(800);
    expect(snippetLines[1]).toHaveLength(200);
  });

  it('allows one adjacent neighbor chunk under the adaptive parent window cap', () => {
    const firstChunk = 'a'.repeat(800);
    const neighborChunk = 'b'.repeat(800);
    const thirdChunk = 'c'.repeat(800);
    const { block } = formatWikiBlock([
      result('projects/alpha.md', 'Alpha', firstChunk, 'Deep Context', 0),
      result('projects/alpha.md', 'Alpha', neighborChunk, 'Deep Context', 1),
      result('projects/alpha.md', 'Alpha', thirdChunk, 'Deep Context', 3),
    ]);

    const snippetLines = block
      .split('\n')
      .filter((line) => line.startsWith('   '))
      .map((line) => line.trim());

    expect(snippetLines.join('').length).toBe(1500);
    expect(snippetLines[0]).toHaveLength(800);
    expect(snippetLines[1]).toHaveLength(700);
    expect(snippetLines).toHaveLength(2);
  });

  it('keeps a minimum of three distinct pages when candidates are available', () => {
    const { injectedPages, block } = formatWikiBlock([
      result('projects/alpha.md', 'Alpha', 'alpha '.repeat(180), 'Overview'),
      result('projects/alpha.md', 'Alpha', 'alpha detail '.repeat(180), 'Details'),
      result('projects/beta.md', 'Beta', 'beta '.repeat(120), 'Overview'),
      result('projects/gamma.md', 'Gamma', 'gamma '.repeat(120), 'Overview'),
    ]);

    const uniquePages = new Set(injectedPages.map((page) => page.path));
    expect(uniquePages.size).toBeGreaterThanOrEqual(3);
    expect(block).toContain('projects/alpha.md');
    expect(block).toContain('projects/beta.md');
    expect(block).toContain('projects/gamma.md');
  });

  it('uses the E026 Candidate G rank-decayed schedule and provenance in active contextual assembly', () => {
    const { block, tokensUsed } = formatWikiBlock(
      [
        result('projects/alpha.md', 'Alpha', 'a'.repeat(2000), 'Overview', 7),
        result('projects/beta.md', 'Beta', 'b'.repeat(2000), 'Details', 2),
        result('projects/gamma.md', 'Gamma', 'c'.repeat(2000), 'More', 3),
        result('projects/delta.md', 'Delta', 'd'.repeat(2000), 'More', 4),
        result('projects/epsilon.md', 'Epsilon', 'e'.repeat(2000), 'More', 5),
      ],
      { activeContextual: true, maxParentTokens: 1000, injectionTokenBudget: 1000 },
    );

    expect(block).toContain('Overview (chunk 7)');
    expect(block).toContain('Details (chunk 2)');
    expect(block).not.toContain('sourceChunkId');
    const snippetLines = block
      .split('\n')
      .filter((line) => line.startsWith('   '))
      .map((line) => line.trim());
    expect(snippetLines[0]).toHaveLength(1440);
    expect(snippetLines[1]).toHaveLength(1040);
    expect(snippetLines[2]).toHaveLength(400);
    expect(snippetLines[3]).toHaveLength(200);
    expect(snippetLines[4]?.length).toBeGreaterThan(0);
    expect(snippetLines[4]?.length).toBeLessThanOrEqual(100);
    expect(tokensUsed).toBeLessThanOrEqual(1000);
  });

  it('enforces the E026 900 estimated-token active contextual injection cap under the deterministic estimator', () => {
    const { block, tokensUsed } = formatWikiBlock(
      Array.from({ length: 12 }, (_, i) => result(`projects/${i}.md`, `Project ${i}`, 'x'.repeat(2000), 'Overview', i)),
      { activeContextual: true, parentTokenBudgets: [360, 260, 100, 50, 25], maxParentTokens: 900, injectionTokenBudget: 900 },
    );

    expect(tokensUsed).toBeLessThanOrEqual(900);
    expect(estimateTokens(block)).toBeLessThanOrEqual(900);
  });

  it('keeps explicit 1000-token active contextual budgets backward-compatible', () => {
    const { block, tokensUsed } = formatWikiBlock(
      Array.from({ length: 12 }, (_, i) => result(`projects/${i}.md`, `Project ${i}`, 'x'.repeat(2000), 'Overview', i)),
      { activeContextual: true, parentTokenBudgets: [400, 300, 125, 100, 75], maxParentTokens: 1000, injectionTokenBudget: 1000 },
    );

    expect(tokensUsed).toBeLessThanOrEqual(1000);
    expect(estimateTokens(block)).toBeLessThanOrEqual(1000);
  });

  it('uses reconstructed parent context from the selected child without needing duplicate search rows', () => {
    const parent = ['first raw parent chunk', 'second raw parent chunk', 'third raw parent chunk'].join('\n\n');
    const { block, injectedPages } = formatWikiBlock(
      [contextualResult('projects/alpha.md', 'Alpha', 'second raw parent chunk', parent, 'Deep Context', 1)],
      { activeContextual: true, parentTokenBudgets: [400, 300, 125, 100, 75], maxParentTokens: 1000 },
    );

    expect(injectedPages).toHaveLength(1);
    expect(block).toContain('first raw parent chunk');
    expect(block).toContain('second raw parent chunk');
    expect(block).toContain('third raw parent chunk');
  });

  it('preserves exact rank-three property evidence through the 100-token active budget', () => {
    const selectedChild = 'Property Details: the home has exactly 2,112 sqft of finished space.';
    const parent = `${'prefix context '.repeat(50)}\n\n${selectedChild}\n\n${'suffix context '.repeat(50)}`;
    const { block, injectedPages } = formatWikiBlock(
      [
        contextualResult('life/a.md', 'A', 'alpha', 'alpha '.repeat(300), 'Overview', 1),
        contextualResult('life/b.md', 'B', 'beta', 'beta '.repeat(240), 'Overview', 2),
        contextualResult('life/home.md', 'Home', selectedChild, parent, 'Property Details', 17),
      ],
      { activeContextual: true, parentTokenBudgets: [360, 260, 100, 50, 25], maxParentTokens: 900, injectionTokenBudget: 900 },
    );

    expect(block).toContain('Property Details (chunk 17)');
    expect(block).toContain('2,112 sqft');
    expect(injectedPages).toHaveLength(3);
    expect(injectedPages[2]?.path).toBe('life/home.md');
  });

  it('leaves fallback/plain assembly on the legacy 1000-token cap', () => {
    const { block, tokensUsed } = formatWikiBlock(
      Array.from({ length: 12 }, (_, i) => result(`projects/plain-${i}.md`, `Plain ${i}`, 'p'.repeat(2000), 'Overview', i)),
    );

    expect(tokensUsed).toBeLessThanOrEqual(1000);
    expect(estimateTokens(block)).toBeLessThanOrEqual(1000);
  });

  it('centers active parent windows around a late matched child when the parent is over budget', () => {
    const lateChild = 'LATE_CHILD_NEEDLE '.repeat(20).trim();
    const parent = `${'early '.repeat(1200)}\n\n${lateChild}\n\n${'tail '.repeat(120)}`;
    const { block, tokensUsed } = formatWikiBlock(
      [contextualResult('projects/late.md', 'Late', lateChild, parent, 'Long Section', 8)],
      { activeContextual: true, parentTokenBudgets: [125], maxParentTokens: 125 },
    );

    expect(block).toContain('LATE_CHILD_NEEDLE');
    expect(block).toContain('Long Section');
    expect(block).not.toContain('early early early early early early early early early early early early early early early early early early early early');
    expect(tokensUsed).toBeLessThanOrEqual(1000);
  });

  describe('E039 same-page sibling completion', () => {
    function withSiblings(base: ReturnType<typeof contextualResult>, siblingCandidates: Array<{ chunkIndex: number; section: string; content: string; score: number }>) {
      return { ...base, siblingCandidates };
    }

    it('appends the highest-scoring sibling from another section when the primary section leaves budget room', () => {
      const { block } = formatWikiBlock(
        [
          withSiblings(
            contextualResult('projects/alpha.md', 'Alpha', 'short child', 'short child', 'Overview', 1),
            [
              { chunkIndex: 5, section: 'Details', content: 'a low scoring sibling chunk', score: 0.1 },
              { chunkIndex: 9, section: 'History', content: 'a high scoring sibling chunk', score: 0.9 },
            ],
          ),
        ],
        { activeContextual: true, parentTokenBudgets: [400, 300, 125, 100, 75], maxParentTokens: 1000, query: 'anything' },
      );

      expect(block).toContain('a high scoring sibling chunk');
      expect(block).toContain('[same-page chunk 9 | History]');
    });

    it('caps sibling completion at 2 even when more candidates are offered', () => {
      const { block } = formatWikiBlock(
        [
          withSiblings(
            contextualResult('projects/alpha.md', 'Alpha', 'short child', 'short child', 'Overview', 1),
            [
              { chunkIndex: 2, section: 'S2', content: 'sibling two', score: 0.9 },
              { chunkIndex: 3, section: 'S3', content: 'sibling three', score: 0.8 },
              { chunkIndex: 4, section: 'S4', content: 'sibling four', score: 0.7 },
            ],
          ),
        ],
        { activeContextual: true, parentTokenBudgets: [400, 300, 125, 100, 75], maxParentTokens: 1000, query: 'anything' },
      );

      expect(block).toContain('sibling two');
      expect(block).toContain('sibling three');
      expect(block).not.toContain('sibling four');
    });

    it('does not append siblings that would push the page over its own rank-decayed budget', () => {
      const { block, tokensUsed } = formatWikiBlock(
        [
          withSiblings(
            contextualResult('projects/tight.md', 'Tight', 'x'.repeat(280), 'x'.repeat(280), 'Overview', 1),
            [{ chunkIndex: 2, section: 'Other', content: 'SIBLING_SHOULD_NOT_FIT '.repeat(30), score: 0.9 }],
          ),
        ],
        { activeContextual: true, parentTokenBudgets: [75], maxParentTokens: 75, query: 'anything' },
      );

      expect(tokensUsed).toBeLessThanOrEqual(1000);
      const pageTokens = Math.ceil(block.length / 4);
      expect(pageTokens).toBeLessThanOrEqual(1000);
    });

    it('skips a sibling whose content is already present in the assembled snippet', () => {
      const duplicateText = 'duplicate content already covered by the primary section text here';
      const { block } = formatWikiBlock(
        [
          withSiblings(
            contextualResult('projects/alpha.md', 'Alpha', duplicateText, duplicateText, 'Overview', 1),
            [{ chunkIndex: 2, section: 'Other', content: duplicateText, score: 0.9 }],
          ),
        ],
        { activeContextual: true, parentTokenBudgets: [400, 300, 125, 100, 75], maxParentTokens: 1000, query: 'anything' },
      );

      expect(block).not.toContain('[same-page chunk 2 | Other]');
    });

    it('is a no-op when no siblingCandidates are provided', () => {
      const { block } = formatWikiBlock(
        [contextualResult('projects/alpha.md', 'Alpha', 'short child', 'short child', 'Overview', 1)],
        { activeContextual: true, parentTokenBudgets: [400, 300, 125, 100, 75], maxParentTokens: 1000, query: 'anything' },
      );

      expect(block).not.toContain('same-page chunk');
    });
  });
});

describe('live-data wiki injection guard', () => {
  it('skips only route-like queries that also require current/live data', () => {
    for (const query of [
      'What is the traffic right now to school?',
      'fastest way today from home to the airport',
      'current driving time to Boulder',
      'live directions to Oasis',
      'best route now',
    ]) {
      expect(shouldSkipWikiInjectionForLiveData(query)).toBe(true);
    }

    for (const query of [
      'What route did we document for the migration?',
      'Directions for configuring Plumb',
      'What is traffic shaping in this architecture?',
      'What happened today in the wiki?',
      'current project status for Plumb',
    ]) {
      expect(shouldSkipWikiInjectionForLiveData(query)).toBe(false);
    }
  });
});
