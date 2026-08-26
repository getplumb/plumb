import { createHash } from 'node:crypto';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function copyDefined(source: UnknownRecord, keys: string[]): UnknownRecord {
  const output: UnknownRecord = {};
  for (const key of keys) {
    if (source[key] !== undefined) output[key] = source[key];
  }
  return output;
}

/**
 * Remove private query/page content from wiki telemetry before it reaches logs.
 * The resulting record contains only operational status, counts, timings,
 * coverage, and a short one-way query hash for turn correlation.
 */
export function sanitizeWikiTelemetryEvent(event: unknown): UnknownRecord {
  const source = asRecord(event);
  if (!source) {
    return { event: 'plumb.wiki_telemetry', status: 'invalid_event' };
  }

  const query = typeof source.query === 'string' ? source.query : undefined;
  const queryHash = query
    ? createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 16)
    : undefined;
  const eventName = typeof source.event === 'string'
    ? source.event
    : 'plumb.wiki_telemetry';

  const sanitized: UnknownRecord = {
    event: eventName,
    ...copyDefined(source, ['mode', 'status', 'reason']),
    ...(queryHash ? { queryHash } : {}),
  };

  if (eventName === 'plumb.wiki_injection') {
    const candidatePages = Array.isArray(source.candidatePages) ? source.candidatePages : [];
    const injectedPages = Array.isArray(source.injectedPages) ? source.injectedPages : [];
    Object.assign(sanitized, {
      candidatePageCount: candidatePages.length,
      injectedPageCount: injectedPages.length,
      ...copyDefined(source, ['budgetTokens', 'tokensUsed', 'elapsedMs', 'topK']),
    });
    return sanitized;
  }

  if (eventName === 'plumb.wiki_contextual_search') {
    const coverage = asRecord(source.coverage);
    Object.assign(sanitized, copyDefined(source, [
      'plainResultCount',
      'contextualResultCount',
      'elapsedMs',
    ]));
    if (coverage) {
      sanitized.coverage = copyDefined(coverage, [
        'totalEligible',
        'contextualDone',
        'mismatchedDimensions',
        'coverageRatio',
      ]);
    }
    return sanitized;
  }

  Object.assign(sanitized, copyDefined(source, ['elapsedMs']));
  return sanitized;
}
