/**
 * wiki-fanout.ts — CLI command: plumb wiki fanout-candidates
 *
 * The deterministic half of fan-out (tranche B2): given the pages a queued fact
 * has already been applied to, which OTHER pages carry a claim the same fact
 * changes? See `packages/core/src/wiki-fanout.ts` for why inbound wikilinks are
 * the propagation index and why excerpts rather than whole pages come back.
 *
 * WHY ONE COMMAND AND NOT TWO. Search and the link graph both need `wiki.db`
 * open and the corpus read, and a `claude -p` process start alone costs seconds
 * — the whole point of doing this deterministically is that it is cheap, so it
 * does not get to pay two node startups either.
 *
 * Read-only end to end: it opens the database, reads pages, and prints JSON.
 * Deciding what to do with the candidates is the caller's problem.
 *
 * Usage:
 *   plumb wiki fanout-candidates --pages people/priya.md --query "<fact>" --json
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

import { collectWikiCorpus, collectFanoutCandidates, WikiStore, WikiSearch } from '@getplumb/core';
import type { FanoutResult } from '@getplumb/core';

export interface WikiFanoutCommandOptions {
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** Path to wiki.db. Defaults to ~/.plumb/wiki.db */
  db?: string;
  /** Comma-separated wiki-relative paths the primary edit already wrote. */
  pages?: string;
  /** Free text to search for. Usually the queued fact. Omit to skip search. */
  query?: string;
  /** Cap on candidates returned. */
  limit?: string;
  /** How many search results to union in. */
  topK?: string;
  json?: boolean;
}

/** rel -> pages linking to it, straight out of `wiki_links`. */
async function loadInbound(dbPath: string): Promise<Map<string, string[]>> {
  const store = await WikiStore.create({ dbPath });
  try {
    const rows = (store.db.exec({
      sql: `SELECT sp.path AS source, tp.path AS target
              FROM wiki_links l
              JOIN wiki_pages sp ON l.source_page_id = sp.id
              JOIN wiki_pages tp ON l.target_page_id = tp.id
             WHERE l.resolved = 1`,
      rowMode: 'object',
      returnValue: 'resultRows',
    }) ?? []) as Array<{ source: string; target: string }>;
    const inbound = new Map<string, string[]>();
    for (const r of rows) {
      // `normalizePath` in core lowercases and strips `.md`; the fan-out module
      // normalizes both sides itself, so raw paths go in here.
      const list = inbound.get(r.target) ?? [];
      if (!list.includes(r.source)) list.push(r.source);
      inbound.set(r.target, list);
    }
    return inbound;
  } finally {
    store.close();
  }
}

export async function wikiFanoutCommand(options: WikiFanoutCommandOptions = {}): Promise<void> {
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');
  const dbPath = options.db ?? join(homedir(), '.plumb', 'wiki.db');
  const entityPages = (options.pages ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (entityPages.length === 0) {
    console.error('fanout-candidates: --pages is required (comma-separated wiki-relative paths)');
    process.exit(2);
  }

  const { corpus } = await collectWikiCorpus(wikiRoot);
  const inbound = await loadInbound(dbPath);

  let searchHits: string[] = [];
  if (options.query !== undefined && options.query.trim() !== '') {
    const topK = Number(options.topK ?? 10);
    try {
      // `preCheck: false` on purpose. The pre-check re-embeds stale pages, and
      // the caller of this command has just rewritten one — it would re-embed
      // the page it is about to fan out FROM, in the middle of a run whose own
      // reindex step exists to do exactly that afterwards.
      const search = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
      const results = await search.search(options.query, topK);
      const seen = new Set<string>();
      for (const r of results) {
        const path = (r as unknown as { path?: string }).path;
        if (typeof path === 'string' && !seen.has(path)) {
          seen.add(path);
          searchHits.push(path);
        }
      }
    } catch (err) {
      // Search is the weaker of the two candidate sources; the link graph is
      // the one the design rests on. Losing search degrades recall, and saying
      // so is better than failing the whole fan-out.
      console.error(
        `fanout-candidates: search unavailable, continuing on inbound links only ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
      searchHits = [];
    }
  }

  const result: FanoutResult = collectFanoutCandidates({
    corpus: corpus.map((p) => ({ rel: p.rel, text: p.text })),
    entityPages,
    inbound,
    searchHits,
    limit: Number(options.limit ?? 8),
  });

  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`Fan-out candidates for ${result.entityPages.join(', ')}`);
  console.log(`  entity names: ${result.entityNames.join(' | ')}`);
  console.log(`  ${result.candidates.length} of ${result.consideredCount} considered`);
  for (const c of result.candidates) {
    console.log(
      `\n  ${c.page} [${c.reasons.join('+')}${c.searchRank !== null ? ` rank ${c.searchRank}` : ''}]`,
    );
    for (const e of c.excerpts) console.log(`    ${e.line}: ${e.text.slice(0, 160)}`);
    if (c.excerpts.length === 0) console.log('    (no line names the entity)');
  }
}
