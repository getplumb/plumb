/**
 * Context builder — formats a MemoryContext into a [MEMORY CONTEXT] string
 * suitable for injection into an agent's system prompt.
 *
 * Output format (example):
 *
 *   [MEMORY CONTEXT]
 *
 *   ## Memories
 *   - [tech-planning] today: "User prefers TypeScript for all new code"
 *
 *   ## Related conversations
 *   - [tech-planning] today: "Let me help you design the memory system..."
 *
 * Always includes a tool hint section. Returns empty string only when both
 * relatedMemories and relatedConversations are empty.
 */

import type { MemoryContext, MemoryFactChunk, RawChunk } from './read-path.js';

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

function formatMemoryLine(memory: MemoryFactChunk): string {
  const excerpt = memory.content.slice(0, 200);
  const sessionLabel = memory.sourceSessionLabel ?? memory.sourceSessionId;
  const ageInDays = (Date.now() - memory.timestamp.getTime()) / (1_000 * 60 * 60 * 24);
  const age = formatAge(ageInDays);
  return `- [${sessionLabel}] ${age}: "${excerpt}"`;
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
 * Always returns a non-empty string with a tool hint section,
 * even when there are no related memories or conversations.
 */
export function formatContextBlock(context: MemoryContext): string {
  const { relatedMemories, relatedConversations } = context;

  const lines: string[] = ['[MEMORY CONTEXT]'];

  // ── Render ## Memories section (above ## Related conversations) ──────────
  if (relatedMemories.length > 0) {
    lines.push('');
    lines.push('## Memories');
    for (const memory of relatedMemories) lines.push(formatMemoryLine(memory));
  }

  // ── Render ## Related conversations section ──────────────────────────────
  if (relatedConversations.length > 0) {
    lines.push('');
    lines.push('## Related conversations');
    for (const chunk of relatedConversations) lines.push(formatChunkLine(chunk));
  }

  // ── Append tool hint ──────────────────────────────────────────────────────
  if (relatedMemories.length > 0 || relatedConversations.length > 0) {
    lines.push('');
    lines.push('## Memory search available');
    lines.push('Use the \`plumb_search\` tool to look up specific subtopics not covered above.');
  } else {
    // No memories or conversations — show only tool hint with alternate text
    lines.push('## Memory search available');
    lines.push('Use the \`plumb_search\` tool to look up relevant context from memory.');
  }

  return lines.join('\n');
}
