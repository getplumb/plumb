/**
 * Context builder — formats a MemoryContext into a [MEMORY CONTEXT] string
 * suitable for injection into an agent's system prompt.
 *
 * Output format (example):
 *
 *   [MEMORY CONTEXT]
 *
 *   ## High confidence facts
 *   - user is building a product called Plumb (0.98, session: tech-planning, today)
 *
 *   ## Medium confidence facts
 *   - user uses TypeScript (0.65, session: dev-chat, 2 days ago)
 *
 *   ## Related conversations
 *   - [tech-planning] today: "Let me help you design the memory system..."
 *
 * Empty MemoryContext returns an empty string — no block is injected.
 */

import type { MemoryContext, ScoredFact, RawChunk } from './read-path.js';

// ─── Age formatting ───────────────────────────────────────────────────────────

/**
 * Converts an age in fractional days to a human-readable string.
 * Examples: 'today', 'yesterday', '3 days ago', '2 weeks ago', '1 month ago'.
 */
export function formatAge(ageInDays: number): string {
  if (ageInDays < 1) return 'today';
  if (ageInDays < 2) return 'yesterday';
  if (ageInDays < 7) return `${Math.floor(ageInDays)} days ago`;
  if (ageInDays < 14) return '1 week ago';
  if (ageInDays < 30) return `${Math.floor(ageInDays / 7)} weeks ago`;
  if (ageInDays < 60) return '1 month ago';
  if (ageInDays < 365) return `${Math.floor(ageInDays / 30)} months ago`;
  if (ageInDays < 730) return '1 year ago';
  return `${Math.floor(ageInDays / 365)} years ago`;
}

// ─── Line formatters ──────────────────────────────────────────────────────────

function formatFactLine(sf: ScoredFact): string {
  const { fact, score, ageInDays } = sf;
  const description = `${fact.subject} ${fact.predicate} ${fact.object}`;
  const sessionLabel = fact.sourceSessionLabel ?? fact.sourceSessionId;
  const age = formatAge(ageInDays);
  return `- ${description} (${score.toFixed(2)}, session: ${sessionLabel}, ${age})`;
}

function formatChunkLine(chunk: RawChunk): string {
  const excerpt = chunk.chunkText.slice(0, 200);
  const sessionLabel = chunk.sessionLabel ?? chunk.sessionId;
  const ageInDays = (Date.now() - chunk.timestamp.getTime()) / (1_000 * 60 * 60 * 24);
  const age = formatAge(ageInDays);
  return `- [${sessionLabel}] ${age}: "${excerpt}"`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Formats a MemoryContext into a [MEMORY CONTEXT] prompt block.
 *
 * Returns an empty string if the context has no facts and no raw chunks,
 * so callers can skip injection without additional checks.
 */
export function formatContextBlock(context: MemoryContext): string {
  const { highConfidence, mediumConfidence, lowConfidence, relatedConversations } = context;

  const isEmpty =
    highConfidence.length === 0 &&
    mediumConfidence.length === 0 &&
    lowConfidence.length === 0 &&
    relatedConversations.length === 0;

  if (isEmpty) return '';

  const lines: string[] = ['[MEMORY CONTEXT]'];

  if (highConfidence.length > 0) {
    lines.push('');
    lines.push('## High confidence facts');
    for (const sf of highConfidence) lines.push(formatFactLine(sf));
  }

  if (mediumConfidence.length > 0) {
    lines.push('');
    lines.push('## Medium confidence facts');
    for (const sf of mediumConfidence) lines.push(formatFactLine(sf));
  }

  if (lowConfidence.length > 0) {
    lines.push('');
    lines.push('## Low confidence facts');
    for (const sf of lowConfidence) lines.push(formatFactLine(sf));
  }

  if (relatedConversations.length > 0) {
    lines.push('');
    lines.push('## Related conversations');
    for (const chunk of relatedConversations) lines.push(formatChunkLine(chunk));
  }

  return lines.join('\n');
}
