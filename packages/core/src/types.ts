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
  /** Stored confidence value (0–1). Defaults to 0.95 if omitted. */
  readonly confidence?: number;
  /** Decay rate for time-based score decay. Defaults to 'slow' if omitted. */
  readonly decayRate?: 'slow' | 'medium' | 'fast';
}
