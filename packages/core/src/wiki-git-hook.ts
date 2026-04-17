/**
 * wiki-git-hook.ts — Post-commit hook installer for ~/.plumb/wiki/.git
 *
 * Installs a post-commit git hook in the wiki's git repository that triggers
 * runWikiEmbed for any .md files changed in the latest commit. This ensures
 * edits committed via Obsidian's git plugin, manual git commits, or any other
 * git workflow are automatically re-indexed without a manual step.
 *
 * Usage (install once):
 *   import { installWikiGitHook } from '@getplumb/core';
 *   await installWikiGitHook({ wikiRoot: '~/.plumb/wiki' });
 *
 * The hook script uses the `plumb-wiki` CLI (from @getplumb/wiki) to run the
 * embed pass. If the CLI is not on PATH, it falls back to `node` with the
 * direct path to wiki-embedder.
 */

import { writeFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiGitHookOptions {
  /** Wiki root directory containing the .git folder. Defaults to ~/.plumb/wiki */
  wikiRoot?: string;
  /**
   * Path to wiki.db. Defaults to ~/.plumb/wiki.db.
   * Passed to the embed CLI via PLUMB_WIKI_DB env var.
   */
  dbPath?: string;
  /** Overwrite an existing hook. Defaults to false (preserve existing hooks). */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Hook script template
// ---------------------------------------------------------------------------

function buildHookScript(wikiRoot: string, dbPath: string): string {
  return `#!/bin/sh
# Plumb wiki post-commit hook — auto re-embed changed wiki pages.
# Installed by @getplumb/core wiki-git-hook.ts
# Do not edit this block; re-run installWikiGitHook() to update.

WIKI_ROOT="${wikiRoot}"
WIKI_DB="${dbPath}"

# Collect .md files changed in the last commit
CHANGED=$(git diff-tree --no-commit-id -r --name-only HEAD | grep '\\.md$' || true)

if [ -z "$CHANGED" ]; then
  exit 0
fi

# Trigger re-embed. Use plumb-wiki CLI if available, otherwise skip silently.
if command -v plumb-wiki > /dev/null 2>&1; then
  PLUMB_WIKI_ROOT="$WIKI_ROOT" PLUMB_WIKI_DB="$WIKI_DB" plumb-wiki embed --quiet || true
else
  # Try npx / pnpx fallback
  if command -v npx > /dev/null 2>&1; then
    PLUMB_WIKI_ROOT="$WIKI_ROOT" PLUMB_WIKI_DB="$WIKI_DB" npx plumb-wiki embed --quiet 2>/dev/null || true
  fi
fi

exit 0
`;
}

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

/**
 * Install a post-commit git hook in the wiki's .git/hooks directory.
 *
 * If the hook file already exists and `force` is false (default), the existing
 * hook is left untouched and this function returns `{ installed: false }`.
 *
 * @returns { installed: boolean; hookPath: string }
 */
export async function installWikiGitHook(
  options: WikiGitHookOptions = {},
): Promise<{ installed: boolean; hookPath: string }> {
  const wikiRoot = options.wikiRoot ?? join(homedir(), '.plumb', 'wiki');
  const dbPath = options.dbPath ?? join(homedir(), '.plumb', 'wiki.db');
  const force = options.force ?? false;

  const hooksDir = join(wikiRoot, '.git', 'hooks');
  const hookPath = join(hooksDir, 'post-commit');

  // Ensure the hooks directory exists (it always does in a real git repo,
  // but may not in tests).
  await mkdir(hooksDir, { recursive: true });

  // Don't overwrite unless forced
  if (!force && existsSync(hookPath)) {
    // Check if it's already our hook — if so, still skip
    const existing = readFileSync(hookPath, 'utf8');
    if (existing.includes('Plumb wiki post-commit hook')) {
      return { installed: false, hookPath };
    }
    // Foreign hook — preserve it
    return { installed: false, hookPath };
  }

  const script = buildHookScript(wikiRoot, dbPath);
  await writeFile(hookPath, script, { encoding: 'utf8' });
  await chmod(hookPath, 0o755);

  return { installed: true, hookPath };
}
