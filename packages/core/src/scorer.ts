/** Lambda applied to raw log chunks (medium decay). */
const RAW_LOG_LAMBDA = 0.012;

/** Cold score threshold — chunks below this are flagged. */
const COLD_THRESHOLD = 0.01;

/** Memory fact score boost multiplier (applied after RRF fusion). */
export const MEMORY_FACT_BOOST = 2.0;

/** Memory fact minimum score threshold (after boost) for fallback logic. */
export const MEMORY_FACT_MIN_SCORE = 0.3;

export interface ScoreResult {
  readonly score: number;
  readonly isCold: boolean;
}

/**
 * Minimal shape required by scoreRawLog().
 * raw_log rows carry a timestamp; other fields are not needed for scoring.
 */
export interface RawLogChunk {
  readonly timestamp: Date;
}

/**
 * Computes the exponential decay multiplier: e^(-lambda × age_in_days).
 */
export function computeDecay(lambda: number, ageInDays: number): number {
  return Math.exp(-lambda * ageInDays);
}

/**
 * Scores a raw log chunk using medium decay (lambda = 0.012).
 * Raw chunks have no confidence field; decay is applied to a base of 1.0.
 */
export function scoreRawLog(
  chunk: RawLogChunk,
  now: Date = new Date(),
): ScoreResult {
  const ageInDays =
    (now.getTime() - chunk.timestamp.getTime()) / (1_000 * 60 * 60 * 24);
  const score = computeDecay(RAW_LOG_LAMBDA, ageInDays);
  return { score, isCold: score < COLD_THRESHOLD };
}

/**
 * Scores a memory fact by applying MEMORY_FACT_BOOST to its hybrid search score.
 * Memory facts are high-signal curated content, so they get a 2.0× boost.
 *
 * @param hybridScore The RRF-fused score from BM25 + vector search.
 * @returns The boosted score.
 */
export function scoreMemoryFact(hybridScore: number): number {
  return hybridScore * MEMORY_FACT_BOOST;
}
