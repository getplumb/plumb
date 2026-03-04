import { callLLM } from './llm-client.js';
import type { MemoryStore } from './store.js';
import { DecayRate, type Fact, type MessageExchange } from './types.js';

/** Shape of a single item returned by the LLM extraction prompt. */
interface RawExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  context?: string;
  confidence: number;
  decay_rate: string;
}

/** Build the extraction prompt from a conversation exchange. */
function buildExtractionPrompt(exchange: MessageExchange): string {
  return (
    `Extract facts from this conversation exchange worth remembering in future conversations.\n\n` +
    `User: ${exchange.userMessage}\n` +
    `Agent: ${exchange.agentResponse}\n\n` +
    `Rules:\n` +
    `- Output ONLY a valid JSON array. No prose, no explanation, no markdown fences.\n` +
    `- Each item: {"subject": string, "predicate": string, "object": string, "context": string, "confidence": number 0-1, "decay_rate": "slow"|"medium"|"fast"}\n` +
    `- decay_rate: slow=identity/stable prefs/decisions, medium=project context/tool choices, fast=transient state\n` +
    `- confidence: 0.95 for explicit statements, 0.7-0.85 for inferred\n` +
    `- Output [] if nothing is worth remembering\n` +
    `- Skip: pleasantries, small talk, transient questions, tool outputs, error messages\n` +
    `- Extract: decisions, preferences, facts about people/projects/systems, deadlines, named entities\n\n` +
    `JSON array:`
  );
}

/**
 * Parse a JSON array from LLM output, tolerating markdown code fences and leading prose.
 * Returns empty array on any parse failure.
 */
function parseJsonArray(text: string): RawExtractedFact[] {
  // Find the first '[' and last ']' — extract just that substring
  const start = text.indexOf('[');
  const end   = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  const jsonSlice = text.slice(start, end + 1).trim();
  const parsed: unknown = JSON.parse(jsonSlice);
  if (!Array.isArray(parsed)) return [];
  return parsed as RawExtractedFact[];
}

function toDecayRate(raw: string): DecayRate {
  if (raw === 'slow') return DecayRate.slow;
  if (raw === 'fast') return DecayRate.fast;
  return DecayRate.medium;
}

/**
 * Extract facts from a conversation exchange via an LLM call.
 *
 * Makes one LLM call, parses the JSON array response, persists each fact via
 * the provided store, and returns the stored Fact[].
 *
 * Dedup strategy: always insert as a new entry — never update an existing fact
 * with the same subject+predicate. Decay scoring (T-006) handles ranking.
 *
 * @param exchange - The conversation exchange to extract facts from.
 * @param userId   - The user ID to scope facts to (passed to store.store()).
 *                   NOTE: LocalStore captures userId at construction time, so
 *                   this param is accepted here for documentation/future use
 *                   but the store itself enforces the scope.
 * @param store    - The MemoryStore instance to persist facts into.
 * @param llmFn    - Optional LLM function to use (injectable for testing).
 */
export async function extractFacts(
  exchange: MessageExchange,
  _userId: string,
  store: MemoryStore,
  llmFn: (prompt: string) => Promise<string> = callLLM,
): Promise<Fact[]> {
  const prompt = buildExtractionPrompt(exchange);
  const response = await llmFn(prompt);

  let rawFacts: RawExtractedFact[];
  try {
    rawFacts = parseJsonArray(response);
  } catch {
    console.error('[plumb/extractor] Failed to parse LLM response as JSON array:', response);
    return [];
  }

  const facts: Fact[] = [];

  for (const raw of rawFacts) {
    const factInput: Omit<Fact, 'id'> = {
      subject: String(raw.subject),
      predicate: String(raw.predicate),
      object: String(raw.object),
      confidence: Math.max(0, Math.min(1, Number(raw.confidence))),
      decayRate: toDecayRate(String(raw.decay_rate)),
      timestamp: new Date(),
      sourceSessionId: exchange.sessionId,
      ...(exchange.sessionLabel !== undefined ? { sourceSessionLabel: exchange.sessionLabel } : {}),
      ...(raw.context !== undefined ? { context: String(raw.context) } : {}),
    };

    // Dedup: always insert as a new entry (do not update existing same subject+predicate).
    // The store always inserts; decay scoring handles which entry wins at retrieval time.
    const id = await store.store(factInput);
    facts.push({ id, ...factInput });
  }

  return facts;
}
