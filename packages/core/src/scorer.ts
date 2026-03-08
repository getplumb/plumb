/** Memory fact score boost multiplier (applied after RRF fusion). */
export const MEMORY_FACT_BOOST = 2.0;

/** Memory fact minimum score threshold (after boost) for fallback logic.
 *  Calibrated for RRF hybrid scores: top ~25% of boosted fact scores qualify.
 */
export const MEMORY_FACT_MIN_SCORE = 0.054;

export interface ScoreResult {
  readonly score: number;
  readonly isCold: boolean;
}

/**
 * Computes the exponential decay multiplier: e^(-lambda × age_in_days).
 */
export function computeDecay(lambda: number, ageInDays: number): number {
  return Math.exp(-lambda * ageInDays);
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
