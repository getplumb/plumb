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
    `Extract facts from this conversation exchange worth recalling in a future session.\n\n` +
    `Apply the 30-day recall test: "If I had no memory of this conversation and someone asked me about this user in 30 days, would knowing this fact help me serve them better?"\n\n` +
    `User: ${exchange.userMessage}\n` +
    `Agent: ${exchange.agentResponse}\n\n` +
    `Extraction tiers (prioritize stable, durable facts):\n` +
    `Tier 1 (always extract): identity, bio, stable preferences, permanent decisions, named relationships, skills/knowledge\n` +
    `Tier 2 (extract if confident): project architecture decisions, tool choices, recurring workflows\n` +
    `Tier 3 (skip unless explicitly significant): events, status updates, transient state, anything already tracked in a task or code\n\n` +
    `Concrete examples:\n` +
    `BAD (skip): "There are 2,162 pending raw_log chunks" — transient state, stale immediately\n` +
    `BAD (skip): "Claude Code ran T-018 independently" — event, already in git history\n` +
    `BAD (skip): "User registered plumb.run" — event, now complete\n` +
    `GOOD (keep): "Clay prefers bullet lists over markdown tables" — stable preference\n` +
    `GOOD (keep): "Plumb uses SQLite + WASM for local storage" — durable decision\n` +
    `GOOD (keep): "Clay's address is , Lafayette, CO" — identity/bio\n\n` +
    `Rules:\n` +
    `- Output ONLY a valid JSON array. No prose, no explanation, no markdown fences.\n` +
    `- Each item: {"subject": string, "predicate": string, "object": string, "context": string, "confidence": number 0-1, "decay_rate": "slow"|"medium"|"fast"}\n` +
    `- decay_rate: slow=identity/stable prefs/decisions, medium=project context/tool choices, fast=transient state\n` +
    `- confidence (calibrated — 0.95 is RARE, reserved for permanent facts):\n` +
    `  * 0.95: Stable biographical/identity facts, verified permanent data\n` +
    `    Example: "Clay lives at , Lafayette, CO" (permanent address)\n` +
    `  * 0.85-0.90: Strong stated preferences, confirmed architectural decisions, recurring behavioral patterns\n` +
    `    Example: "Clay prefers bullet lists over markdown tables" (stated preference, stable)\n` +
    `  * 0.70-0.84: Inferred preferences, situational context, likely-but-not-certain facts\n` +
    `    Example: "Clay seems to prefer morning standup calls" (inferred from behavior)\n` +
    `  * 0.50-0.69: Speculative observations, one-time mentions, might-be-outdated\n` +
    `    Example: "Clay might be considering switching to a new job" (speculative)\n` +
    `  * Below 0.50: Do NOT extract — output [] instead (not worth storing)\n` +
    `- Output [] liberally — it is better to extract nothing than to extract low-value facts that will pollute future retrieval.\n` +
    `- Skip: pleasantries, small talk, transient questions, tool outputs, error messages, current date/time statements, agent operating instructions (what the agent should do/read/reply), session identifiers, heartbeat/cron state, facts about the agent itself (unless the agent has a permanent attribute like a name or email), events already recorded elsewhere (git commits, kanban tasks, emails), transient project state\n` +
    `- Extract: identity/bio, stable preferences, permanent decisions, named relationships, skills/knowledge, project architecture (if durable), tool choices (if durable), recurring workflows\n\n` +
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
 * Filter out ephemeral and agent-instruction facts that should not be stored.
 *
 * Blocks noise patterns:
 * - Current time/date statements (e.g., 'Current time is Friday...')
 * - Session identifiers (e.g., 'Current session is identified by...')
 * - Agent operating instructions (e.g., 'Agent should reply HEARTBEAT_OK')
 * - Heartbeat/cron state facts
 *
 * Does NOT block valid facts like:
 * - 'Agent is named Terra' (permanent attribute)
 * - 'Clay prefers agent to draft emails' (user preference)
 */
function isNoiseFact(fact: RawExtractedFact): boolean {
  const subjectLower = fact.subject.toLowerCase();
  const predicateLower = fact.predicate.toLowerCase();
  const objectLower = fact.object.toLowerCase();

  // Block ephemeral timestamp subjects
  const blockedSubjects = [
    'current time',
    'current date',
    'current session',
    'today',
    "today's date",
  ];
  if (blockedSubjects.some(blocked => subjectLower.includes(blocked))) {
    return true;
  }

  // Block agent imperative predicates (instructions to the agent)
  const blockedPredicates = [
    'should reply',
    'must reply',
    'should read',
    'must read',
    'should not infer',
    'must not repeat',
    'should not repeat',
    'must not',
    'should not',
  ];
  if (blockedPredicates.some(blocked => predicateLower.includes(blocked))) {
    return true;
  }

  // Block Agent + imperative (should/must) combinations
  // BUT allow 'Agent is named X' or 'Agent has email X' (permanent attributes)
  if (subjectLower === 'agent') {
    // If predicate is a permanent attribute verb, allow it
    const permanentPredicates = ['is named', 'has email', 'is called', 'name is', 'email is'];
    const isPermanentAttribute = permanentPredicates.some(perm =>
      predicateLower.includes(perm)
    );
    if (!isPermanentAttribute) {
      // Block agent operating instructions
      if (predicateLower.includes('should') || predicateLower.includes('must') ||
          predicateLower.includes('needs to') || predicateLower.includes('will')) {
        return true;
      }
    }
  }

  // Block date/time patterns in object field (e.g., '2026-03-06', 'Friday, March 6th, 2026')
  const dateTimePattern = /\d{4}-\d{2}-\d{2}|(monday|tuesday|wednesday|thursday|friday|saturday|sunday).*\d{4}|\d{1,2}:\d{2}\s*(am|pm)/i;
  if (predicateLower === 'is' && dateTimePattern.test(objectLower)) {
    return true;
  }

  // Block session identifier patterns
  if (objectLower.includes('openclaw session') || objectLower.includes('session 0x')) {
    return true;
  }

  // Block heartbeat-related facts
  if (subjectLower.includes('heartbeat') || objectLower.includes('heartbeat')) {
    return true;
  }

  return false;
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
 * @param sourceChunkId - Optional raw_log chunk ID (T-079 processing state machine).
 */
export async function extractFacts(
  exchange: MessageExchange,
  _userId: string,
  store: MemoryStore,
  llmFn: (prompt: string) => Promise<string> = callLLM,
  sourceChunkId?: string,
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
    // Post-extraction noise filter: discard ephemeral facts before storing
    if (isNoiseFact(raw)) {
      continue;
    }

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
    // T-079: Pass sourceChunkId to link fact back to raw_log chunk.
    const id = await store.store(factInput, sourceChunkId);
    facts.push({ id, ...factInput });
  }

  return facts;
}
