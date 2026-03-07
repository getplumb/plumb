/**
 * Context builder — formats a MemoryContext into a [MEMORY CONTEXT] string
 * suitable for injection into an agent's system prompt.
 *
 * Output format (example):
 *
 *   [MEMORY CONTEXT]
 *
 *   ## Related conversations
 *   - [tech-planning] today: "Let me help you design the memory system..."
 *
 * Empty MemoryContext returns an empty string — no block is injected.
 */

import type { MemoryContext, RawChunk } from './read-path.js';

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
 * Returns an empty string if the context has no raw chunks,
 * so callers can skip injection without additional checks.
 */
export function formatContextBlock(context: MemoryContext): string {
  const { relatedConversations } = context;

  if (relatedConversations.length === 0) return '';

  const lines: string[] = ['[MEMORY CONTEXT]'];

  lines.push('');
  lines.push('## Related conversations');
  for (const chunk of relatedConversations) lines.push(formatChunkLine(chunk));

  return lines.join('\n');
}
