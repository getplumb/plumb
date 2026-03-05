export enum DecayRate {
  slow = 'slow',
  medium = 'medium',
  fast = 'fast',
}

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
  readonly context?: string;
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
  readonly factsExtracted: number;
  readonly factIds: readonly string[];
  readonly skipped?: boolean;
}

export interface StoreStatus {
  readonly factCount: number;
  readonly rawLogCount: number;
  readonly lastIngestion: Date | null;
  readonly storageBytes: number;
}

export interface SearchResult {
  readonly fact: Fact;
  readonly score: number;
  readonly ageInDays: number;
}
