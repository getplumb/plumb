/**
 * Decay rate enum for domain Fact objects.
 * Controls the lambda used in exponential decay scoring.
 *   slow   → lambda = 0.003  (stays relevant for ~1 year)
 *   medium → lambda = 0.012  (decays over ~3–6 months)
 *   fast   → lambda = 0.05   (decays over weeks)
 */
export const DecayRate = {
  slow: 'slow',
  medium: 'medium',
  fast: 'fast',
} as const;

export type DecayRate = (typeof DecayRate)[keyof typeof DecayRate];

/**
 * Domain-level Fact — a single scored memory fact with provenance.
 * Distinct from MemoryFact (the raw DB row); this is the live, scored object
 * used by the read path and scorer.
 */
export interface Fact {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly confidence: number;
  readonly decayRate: DecayRate;
  readonly timestamp: Date;
  readonly sourceSessionId: string;
  readonly sourceSessionLabel?: string;
}

/**
 * A fact returned from store.search(), paired with a store-side score and age.
 */
export interface SearchResult {
  readonly fact: Fact;
  /** Store-side relevance score (e.g. BM25 or vector similarity). */
  readonly score: number;
  readonly ageInDays: number;
}

export interface MessageExchange {
  readonly userMessage: string;
  readonly agentResponse: string;
  readonly timestamp: Date;
  readonly source: 'openclaw' | 'claude-code' | 'claude-desktop';
  readonly sessionId: string;
  readonly sessionLabel?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface IngestResult {
  readonly rawLogId: string;
  readonly skipped?: boolean;
  /** Number of facts extracted from this exchange (T-005, future). Always 0 for now. */
  readonly factsExtracted: number;
  /** IDs of extracted facts (T-005, future). Always [] for now. */
  readonly factIds: string[];
}

export interface StoreStatus {
  readonly rawLogCount: number;
  /** Count of curated memory facts (memory_facts table). */
  readonly factCount: number;
  readonly lastIngestion: Date | null;
  readonly storageBytes: number;
}

export interface MemoryFact {
  readonly id: string;
  readonly userId: string;
  readonly content: string;
  readonly sourceSessionId: string;
  readonly tags: readonly string[] | null;
  readonly createdAt: string;
  readonly embedStatus: string;
  readonly embedError: string | null;
  readonly embedModel: string | null;
  readonly vecRowid: number | null;
}

export interface IngestMemoryFactInput {
  readonly content: string;
  readonly sourceSessionId: string;
  readonly tags?: readonly string[];
}
