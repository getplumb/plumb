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
}

export interface StoreStatus {
  readonly rawLogCount: number;
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
