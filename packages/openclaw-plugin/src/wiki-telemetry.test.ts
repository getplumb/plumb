import { describe, expect, it } from 'vitest';
import { sanitizeWikiTelemetryEvent } from './wiki-telemetry.js';

describe('sanitizeWikiTelemetryEvent', () => {
  it('logs injection counts and timings without private query or page metadata', () => {
    const output = sanitizeWikiTelemetryEvent({
      event: 'plumb.wiki_injection',
      mode: 'v2',
      status: 'fired',
      reason: 'ok',
      query: 'private question about the user',
      candidatePages: [{ path: 'people/private.md', title: 'Private Person' }],
      injectedPages: [{ path: 'people/private.md', tokens: 123 }],
      budgetTokens: 1000,
      tokensUsed: 123,
      elapsedMs: 42,
      topK: 5,
    });

    expect(output).toMatchObject({
      event: 'plumb.wiki_injection',
      mode: 'v2',
      status: 'fired',
      reason: 'ok',
      candidatePageCount: 1,
      injectedPageCount: 1,
      budgetTokens: 1000,
      tokensUsed: 123,
      elapsedMs: 42,
      topK: 5,
    });
    expect(output.queryHash).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(output)).not.toContain('private question');
    expect(JSON.stringify(output)).not.toContain('people/private.md');
    expect(JSON.stringify(output)).not.toContain('Private Person');
  });

  it('keeps contextual coverage and result counts while removing the query', () => {
    const output = sanitizeWikiTelemetryEvent({
      event: 'plumb.wiki_contextual_search',
      mode: 'shadow',
      status: 'ok',
      query: 'another private query',
      plainResultCount: 5,
      contextualResultCount: 5,
      elapsedMs: 88,
      coverage: {
        totalEligible: 1028,
        contextualDone: 1028,
        mismatchedDimensions: 0,
        coverageRatio: 1,
        privateExtra: 'do not log',
      },
    });

    expect(output).toMatchObject({
      event: 'plumb.wiki_contextual_search',
      mode: 'shadow',
      status: 'ok',
      plainResultCount: 5,
      contextualResultCount: 5,
      elapsedMs: 88,
      coverage: {
        totalEligible: 1028,
        contextualDone: 1028,
        mismatchedDimensions: 0,
        coverageRatio: 1,
      },
    });
    expect(JSON.stringify(output)).not.toContain('another private query');
    expect(JSON.stringify(output)).not.toContain('do not log');
  });

  it('returns a safe record for malformed input', () => {
    expect(sanitizeWikiTelemetryEvent('bad')).toEqual({
      event: 'plumb.wiki_telemetry',
      status: 'invalid_event',
    });
  });
});
