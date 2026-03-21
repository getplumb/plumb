/**
 * Context builder — formats a MemoryContext into a [PLUMB MEMORY] string
 * suitable for injection into an agent's system prompt.
 *
 * Output format (example):
 *
 *   [PLUMB MEMORY]
 *
 *   ## Remembered facts
 *   [HIGH] [tech-planning] today: "User prefers TypeScript for all new code"
 *   [MED]  [plumb-dev] 3 days ago: "Plumb uses BM25 + vector KNN..."
 *
 * Tier labels: [HIGH] = strong match (treat as fact), [MED] = likely, [LOW] = hint.
 * Always includes a tool hint section. Returns empty string only when
 * relatedMemories is empty.
 */

import type { MemoryContext, MemoryFactChunk } from './read-path.js';

// ─── Confidence tier helpers ──────────────────────────────────────────────────

/**
 * Maps a boosted memory fact score to a display tier label.
 * Thresholds are calibrated for RRF hybrid scores (BM25 + vector KNN) after
 * MEMORY_FACT_BOOST (2.0×) is applied. Observed boosted score range: 0.044–0.066.
 *   [HIGH] ≥ 0.062 — top ~10%: strong match, treat as ground truth
 *   [MED]  0.054–0.062 — middle band: likely relevant
 *   [LOW]  < 0.054 — bottom half: weak signal, treat as hint
 */
export function scoreFactTier(boostedScore: number): '[HIGH]' | '[MED] ' | '[LOW] ' {
  if (boostedScore >= 0.062) return '[HIGH]';
  if (boostedScore >= 0.054) return '[MED] ';
  return '[LOW] ';
}

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
  const tier = scoreFactTier(memory.score);
  const excerpt = memory.content;
  const sessionLabel = memory.sourceSessionLabel ?? memory.sourceSessionId;
  const ageInDays = (Date.now() - memory.timestamp.getTime()) / (1_000 * 60 * 60 * 24);
  const age = formatAge(ageInDays);
  return `${tier} [${sessionLabel}] ${age}: "${excerpt}"`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Formats a MemoryContext into a [MEMORY CONTEXT] prompt block.
 *
 * Always returns a non-empty string with a tool hint section,
 * even when there are no related memories.
 */
export function formatContextBlock(context: MemoryContext): string {
  const { relatedMemories } = context;

  const lines: string[] = ['[PLUMB MEMORY]'];

  // ── Render ## Remembered facts section (memory_facts, Layer 2) ──────────
  if (relatedMemories.length > 0) {
    lines.push('');
    lines.push('## Remembered facts');
    for (const memory of relatedMemories) lines.push(formatMemoryLine(memory));
  }

  // ── Append tool hints ─────────────────────────────────────────────────────
  if (relatedMemories.length > 0) {
    lines.push('');
    lines.push('## Memory tools available');
    lines.push('- `plumb_search` — search for specific subtopics not covered above');
    lines.push('- `plumb_remember` — store a new fact for future sessions');
  } else {
    // No memories — show only tool hints with alternate text
    lines.push('## Memory tools available');
    lines.push('- `plumb_search` — look up relevant context from memory');
    lines.push('- `plumb_remember` — store a new fact for future sessions');
  }

  return lines.join('\n');
}
