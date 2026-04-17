/**
 * wiki-watcher.ts — File-system watcher for automatic wiki re-embedding.
 *
 * Watches the wiki root directory for any file changes (Obsidian edits, manual
 * edits, git checkouts, etc.) and triggers runWikiEmbed after a 30-second
 * debounce window.
 *
 * Uses Node.js native fs.watch (backed by inotify on Linux, FSEvents on macOS)
 * to avoid external dependencies.
 *
 * Usage:
 *   const watcher = startWikiWatcher({ wikiRoot, dbPath });
 *   // …later…
 *   watcher.stop();
 */

import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runWikiEmbed } from './wiki-embedder.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiWatcherOptions {
  /** Wiki root directory to watch. Defaults to ~/.plumb/wiki */
  wikiRoot?: string;
  /** Path to wiki.db. Defaults to ~/.plumb/wiki.db */
  dbPath?: string;
  /**
   * Debounce window in milliseconds. A re-embed is triggered this many ms
   * after the last observed file change. Defaults to 30_000 (30 seconds).
   */
  debounceMs?: number;
  /** Log watcher events to stdout. Defaults to false. */
  verbose?: boolean;
}

export interface WikiWatcher {
  /** Stop watching and cancel any pending debounced re-embed. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Start watching the wiki root directory for changes.
 *
 * Each file change resets the debounce timer. After `debounceMs` ms of quiet,
 * runWikiEmbed is called to re-index changed pages (hash-based incremental, so
 * only truly changed pages are re-embedded).
 *
 * Returns a handle with a stop() method to tear down the watcher.
 */
export function startWikiWatcher(options: WikiWatcherOptions = {}): WikiWatcher {
  const wikiRoot = options.wikiRoot ?? join(homedir(), '.plumb', 'wiki');
  const dbPath = options.dbPath ?? join(homedir(), '.plumb', 'wiki.db');
  const debounceMs = options.debounceMs ?? 30_000;
  const verbose = options.verbose ?? false;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let embedInProgress = false;
  let pendingAfterEmbed = false;

  function scheduleEmbed() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      if (embedInProgress) {
        pendingAfterEmbed = true;
        return;
      }
      await triggerEmbed();
    }, debounceMs);
  }

  async function triggerEmbed() {
    embedInProgress = true;
    try {
      if (verbose) {
        console.log(`[wiki-watcher] File changes detected — running re-embed at ${new Date().toISOString()}`);
      }
      await runWikiEmbed({ wikiRoot, dbPath, verbose });
    } catch (err) {
      if (verbose) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[wiki-watcher] Re-embed error: ${msg}`);
      }
    } finally {
      embedInProgress = false;
      if (pendingAfterEmbed) {
        pendingAfterEmbed = false;
        scheduleEmbed();
      }
    }
  }

  let watcher: FSWatcher | null = null;

  try {
    watcher = watch(wikiRoot, { recursive: true }, (eventType, filename) => {
      // Only react to .md file changes
      if (typeof filename === 'string' && !filename.endsWith('.md')) return;
      if (verbose) {
        console.log(`[wiki-watcher] ${eventType}: ${filename ?? 'unknown'}`);
      }
      scheduleEmbed();
    });

    watcher.on('error', (err) => {
      if (verbose) {
        console.error(`[wiki-watcher] Watch error: ${err.message}`);
      }
    });
  } catch (err) {
    // If the wikiRoot doesn't exist yet, the watcher silently no-ops
    if (verbose) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[wiki-watcher] Could not start watcher on ${wikiRoot}: ${msg}`);
    }
  }

  return {
    stop() {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      watcher?.close();
    },
  };
}
