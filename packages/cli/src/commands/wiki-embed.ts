/**
 * wiki-embed.ts — CLI command: plumb wiki embed
 *
 * Reads all wiki pages under ~/.plumb/wiki/, chunks them into ~200-token
 * paragraph-aware segments, embeds each chunk using the local bge-small-en-v1.5
 * model, and stores the results in wiki.db.
 *
 * Supports incremental re-embedding: pages whose content_hash hasn't changed
 * are skipped automatically. Obsidian manual edits (which change the hash)
 * trigger re-embedding on the next run.
 *
 * Usage:
 *   plumb wiki embed [--wiki <path>] [--db <path>] [--verbose]
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { runWikiEmbed } from '@getplumb/core';
import type { WikiEmbedStats } from '@getplumb/core';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WikiEmbedOptions {
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** Path to wiki.db. Defaults to ~/.plumb/wiki.db */
  db?: string;
  /** Print per-page progress. Defaults to false. */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Embed all wiki pages into wiki.db.
 *
 * Prints a summary of pages embedded, skipped, and any errors.
 */
export async function wikiEmbedCommand(options: WikiEmbedOptions = {}): Promise<void> {
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');
  const dbPath = options.db ?? join(homedir(), '.plumb', 'wiki.db');
  const verbose = options.verbose ?? false;

  console.log(`Embedding wiki pages…`);
  console.log(`  wiki: ${wikiRoot}`);
  console.log(`  db:   ${dbPath}`);

  let stats: WikiEmbedStats;
  try {
    stats = await runWikiEmbed({ wikiRoot, dbPath, verbose });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nFailed to run wiki embed: ${msg}`);
    process.exit(1);
  }

  console.log(`\nDone.`);
  console.log(`  Total pages:    ${stats.total}`);
  console.log(`  Embedded:       ${stats.embedded}  (${stats.chunks} chunks)`);
  console.log(`  Skipped:        ${stats.skipped}  (hash unchanged)`);
  if (stats.errors > 0) {
    console.log(`  Errors:         ${stats.errors}`);
  }
}
