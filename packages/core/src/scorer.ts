import { DecayRate, type Fact } from './types.js';

/**
 * Lambda decay constants per decay rate.
 * These control how quickly a fact loses relevance over time.
 *   slow   (0.003): identity, stable preferences — half-life ~231 days
 *   medium (0.012): tool prefs, project context — half-life ~58 days
 *   fast   (0.050): transient state — half-life ~14 days
 */
const LAMBDA: Record<DecayRate, number> = {
  [DecayRate.slow]: 0.003,
  [DecayRate.medium]: 0.012,
  [DecayRate.fast]: 0.05,
};

/** Lambda applied to raw log chunks (medium decay). */
const RAW_LOG_LAMBDA = 0.012;

/** Cold score threshold — facts below this are flagged but never deleted. */
const COLD_THRESHOLD = 0.01;

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
 * Scores a fact at read time using:
 *   score = base_confidence × e^(-lambda × age_in_days) × retrieval_frequency_boost
 *
 * Returns a ScoreResult with the computed score (0–1) and an isCold flag.
 * Facts are never deleted — cold facts (score < 0.01) remain queryable.
 */
export function scoreFact(fact: Fact, now: Date = new Date()): ScoreResult {
  const ageInDays =
    (now.getTime() - fact.timestamp.getTime()) / (1_000 * 60 * 60 * 24);
  const lambda = LAMBDA[fact.decayRate];
  const decay = computeDecay(lambda, ageInDays);
  // TODO: retrieval_frequency_boost — track access frequency in T-008 read path;
  //       for now we use 1.0 (no boost) as a placeholder.
  const boost = 1.0;
  const score = fact.confidence * decay * boost;
  return { score, isCold: score < COLD_THRESHOLD };
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
