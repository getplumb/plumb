/**
 * cost-tracker.ts — LLM cost tracking for Plumb wiki operations.
 *
 * Provides:
 *   - Pricing constants for all models used in the wiki pipeline
 *   - computeCost(model, tokensIn, tokensOut) → USD
 *   - recordLlmCost(db, ...) → INSERT into wiki_changelog
 *   - getDailySpend(db, date) → total cost_usd summed for a date
 *   - readDailyBudget() → wikiDailyBudgetUsd from ~/.plumb/config.json (default $2.00)
 *   - isOverBudget(db) → boolean; checks today's spend vs budget
 *   - nextMidnightMT() → ISO date string "YYYY-MM-DD 00:00" in America/Denver
 *
 * Source labels (stored in wiki_changelog.source):
 *   dream              — Haiku catch-up scan in wiki-dream
 *   worker:resolver    — Haiku resolver in wiki-worker
 *   worker:writer      — Sonnet writer in wiki-worker
 *   embed              — Embedding (local bge-small; $0 but tracked for completeness)
 *   rerank             — Rerank (local cross-encoder; $0)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { WasmDb } from './wasm-db.js';

// ---------------------------------------------------------------------------
// Pricing constants (USD per 1 million tokens)
// ---------------------------------------------------------------------------

/** claude-haiku-4-5-20251001 */
export const HAIKU_PRICE_IN  = 0.80;  // $0.80 / MTok input
export const HAIKU_PRICE_OUT = 4.00;  // $4.00 / MTok output

/** claude-sonnet-4-6 */
export const SONNET_PRICE_IN  = 3.00;  // $3.00 / MTok input
export const SONNET_PRICE_OUT = 15.00; // $15.00 / MTok output

/** Local embedding / rerank — zero cost */
export const LOCAL_PRICE_IN  = 0;
export const LOCAL_PRICE_OUT = 0;

// ---------------------------------------------------------------------------
// Model → pricing map
// ---------------------------------------------------------------------------

const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5-20251001': { in: HAIKU_PRICE_IN,  out: HAIKU_PRICE_OUT },
  'claude-haiku-4-5':          { in: HAIKU_PRICE_IN,  out: HAIKU_PRICE_OUT },
  'claude-sonnet-4-6':         { in: SONNET_PRICE_IN, out: SONNET_PRICE_OUT },
  'claude-sonnet-4-5':         { in: SONNET_PRICE_IN, out: SONNET_PRICE_OUT },
  embed:                       { in: LOCAL_PRICE_IN,  out: LOCAL_PRICE_OUT },
  rerank:                      { in: LOCAL_PRICE_IN,  out: LOCAL_PRICE_OUT },
};

/**
 * Compute the USD cost for a model call.
 * Returns 0 for unknown models (avoids hard failures on new model IDs).
 */
export function computeCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = MODEL_PRICING[model] ?? { in: 0, out: 0 };
  return (tokensIn * pricing.in + tokensOut * pricing.out) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Config — ~/.plumb/config.json
// ---------------------------------------------------------------------------

export interface PlumbConfig {
  /** Daily LLM budget ceiling in USD. Default: 2.00 */
  wikiDailyBudgetUsd?: number;
  [key: string]: unknown;
}

const CONFIG_PATH = join(homedir(), '.plumb', 'config.json');
const DEFAULT_DAILY_BUDGET = 2.00;

/** Read ~/.plumb/config.json, returning defaults if absent or malformed. */
export function readPlumbConfig(): PlumbConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as PlumbConfig;
  } catch {
    return {};
  }
}

/** Return the configured daily wiki budget (default $2.00). */
export function readDailyBudget(): number {
  const cfg = readPlumbConfig();
  const val = cfg.wikiDailyBudgetUsd;
  if (typeof val === 'number' && val > 0) return val;
  return DEFAULT_DAILY_BUDGET;
}

/**
 * Ensure ~/.plumb/config.json exists with wikiDailyBudgetUsd set.
 * Only writes the file if it doesn't exist yet or the key is missing.
 */
export function ensureDefaultConfig(): void {
  const dir = dirname(CONFIG_PATH);
  mkdirSync(dir, { recursive: true });

  let existing: PlumbConfig = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as PlumbConfig;
    } catch {
      // malformed — overwrite
    }
  }

  if (typeof existing.wikiDailyBudgetUsd !== 'number') {
    existing.wikiDailyBudgetUsd = DEFAULT_DAILY_BUDGET;
    writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Record LLM cost to wiki_changelog
// ---------------------------------------------------------------------------

export interface LlmCostRecord {
  /** Source label: dream | worker:resolver | worker:writer | embed | rerank */
  source: string;
  /** LLM model ID */
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Optional page this call was associated with */
  pageId?: string | null;
  /** Optional source_ref (queue item id, date string, etc.) */
  sourceRef?: string | null;
}

/**
 * Insert a cost-tracking row into wiki_changelog.
 * Uses action='llm_call' to distinguish from content-change entries.
 * Non-fatal: logs a warning and returns on DB errors rather than throwing.
 */
export function recordLlmCost(db: WasmDb, record: LlmCostRecord): void {
  try {
    const detail = JSON.stringify({
      model: record.model,
      tokens_in: record.tokensIn,
      tokens_out: record.tokensOut,
    });

    const stmt = db.prepare(`
      INSERT INTO wiki_changelog
        (page_id, action, detail, source_ref, source, tokens_in, tokens_out, cost_usd, created_at)
      VALUES (?, 'llm_call', ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.bind([
      record.pageId ?? null,
      detail,
      record.sourceRef ?? null,
      record.source,
      record.tokensIn,
      record.tokensOut,
      record.costUsd,
      new Date().toISOString(),
    ]);
    stmt.step();
    stmt.finalize();
  } catch {
    // Non-fatal: cost recording should never abort the calling operation
  }
}

// ---------------------------------------------------------------------------
// Daily spend query
// ---------------------------------------------------------------------------

/**
 * Sum all cost_usd entries in wiki_changelog for a given UTC date (YYYY-MM-DD).
 * Covers both 'llm_call' and legacy 'dream_run' entries.
 */
export function getDailySpend(db: WasmDb, date: string): number {
  try {
    const stmt = db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM wiki_changelog
       WHERE cost_usd IS NOT NULL
         AND created_at >= ?
         AND created_at < ?`,
    );
    stmt.bind([`${date}T00:00:00.000Z`, `${date}T23:59:59.999Z`]);
    let total = 0;
    if (stmt.step()) {
      const row = stmt.get({}) as { total?: number } | null;
      total = (row as { total?: number } | null)?.total ?? 0;
    }
    stmt.finalize();
    return total;
  } catch {
    return 0;
  }
}

/**
 * Return true if today's spend already meets or exceeds the configured daily budget.
 */
export function isOverDailyBudget(db: WasmDb): boolean {
  const today = new Date().toISOString().slice(0, 10);
  const spent = getDailySpend(db, today);
  const budget = readDailyBudget();
  return spent >= budget;
}

// ---------------------------------------------------------------------------
// Next midnight Mountain Time
// ---------------------------------------------------------------------------

/**
 * Return the ISO date string "YYYY-MM-DD" for tomorrow in America/Denver
 * (Mountain Time, which observes DST).
 *
 * Used for the throttle log message: "throttled until YYYY-MM-DD 00:00 MT"
 */
export function nextMidnightMT(): string {
  // Get tomorrow's date in MT
  const now = new Date();
  const mtString = now.toLocaleDateString('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA locale returns YYYY-MM-DD format
  // Advance to next day
  const [year, month, day] = mtString.split('-').map(Number) as [number, number, number];
  const nextDay = new Date(year, month - 1, day + 1);
  const yyyy = nextDay.getFullYear();
  const mm = String(nextDay.getMonth() + 1).padStart(2, '0');
  const dd = String(nextDay.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Return the UTC milliseconds timestamp for the next 00:00:00 America/Denver.
 * Used by the worker to know when to stop throttling.
 */
export function nextMidnightMTMs(): number {
  const nextDate = nextMidnightMT();
  // Midnight Mountain Time = UTC midnight + offset (7h standard, 6h DST)
  // Use Intl to determine the current offset
  const testMs = new Date(`${nextDate}T00:00:00`).getTime();
  // Adjust for MT offset: find the UTC time that corresponds to MT midnight
  // We do this by getting the MT offset from a reference point
  const refDate = new Date(`${nextDate}T00:00:00Z`);
  const mtOffset = getMtOffsetMinutes(refDate);
  return refDate.getTime() + mtOffset * 60 * 1000;
}

function getMtOffsetMinutes(date: Date): number {
  // America/Denver offset from UTC (negative means behind UTC)
  // MDT = UTC-6, MST = UTC-7
  // We compute by formatting a known UTC date in the target timezone
  const utcStr = date.toLocaleString('en-US', { timeZone: 'America/Denver', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' });
  // utcStr format: "MM/DD/YYYY, HH:MM:SS"
  const match = /(\d+)\/(\d+)\/(\d+),\s+(\d+):(\d+):(\d+)/.exec(utcStr);
  if (!match) return -6 * 60; // fallback MDT
  const [, mo, dy, yr, hr, mi] = match.map(Number) as [number, number, number, number, number, number];
  const mtLocalMs = new Date(yr, mo - 1, dy, hr, mi, 0).getTime();
  return (mtLocalMs - date.getTime()) / 60000;
}

// ---------------------------------------------------------------------------
// Weekly cost breakdown by source
// ---------------------------------------------------------------------------

export interface WeeklyCostRow {
  source: string;
  totalCost: number;
  totalTokensIn: number;
  totalTokensOut: number;
  callCount: number;
}

/**
 * Aggregate cost by source for the last `daysBack` days.
 * Covers both llm_call and legacy dream_run rows.
 */
export function getWeeklyCostBySource(db: WasmDb, daysBack = 7): WeeklyCostRow[] {
  try {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - daysBack);
    const cutoffStr = cutoff.toISOString();

    const stmt = db.prepare(`
      SELECT
        COALESCE(source, 'dream') AS source,
        COALESCE(SUM(cost_usd), 0) AS total_cost,
        COALESCE(SUM(tokens_in), 0) AS total_tokens_in,
        COALESCE(SUM(tokens_out), 0) AS total_tokens_out,
        COUNT(*) AS call_count
      FROM wiki_changelog
      WHERE cost_usd IS NOT NULL
        AND created_at >= ?
      GROUP BY COALESCE(source, 'dream')
      ORDER BY total_cost DESC
    `);
    stmt.bind([cutoffStr]);

    const result: WeeklyCostRow[] = [];
    while (stmt.step()) {
      const row = stmt.get({}) as {
        source?: string;
        total_cost?: number;
        total_tokens_in?: number;
        total_tokens_out?: number;
        call_count?: number;
      };
      result.push({
        source: row.source ?? 'unknown',
        totalCost: row.total_cost ?? 0,
        totalTokensIn: row.total_tokens_in ?? 0,
        totalTokensOut: row.total_tokens_out ?? 0,
        callCount: row.call_count ?? 0,
      });
    }
    stmt.finalize();
    return result;
  } catch {
    return [];
  }
}
