import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

type PatcherLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  debug?: (message: string) => void;
};

/**
 * Content to append to AGENTS.md when Plumb is first activated.
 * Instructs the agent how to use Plumb across sessions.
 */
export const AGENTS_MD_SECTION = `
## Plumb Memory
- \`[PLUMB MEMORY]\` block is injected automatically before each response — no manual file reads needed
- Use \`plumb_remember("fact")\` to store new facts for future sessions (stored in ~/.plumb/memory.db)
- Use \`plumb_search("query")\` for targeted mid-reasoning lookups
- Write dated backup logs to memory/YYYY-MM-DD.md (human-readable logbook for Clay — NOT a retrieval source)
- Do NOT rewrite MEMORY.md as primary memory — Plumb owns retrieval; MEMORY.md is for hard invariants only
`;

/**
 * Content to append to MEMORY.md when Plumb is first activated.
 * Adds a brief Plumb reference to the hard-invariants file.
 */
export const MEMORY_MD_SECTION = `
## Plumb Memory
- \`[PLUMB MEMORY]\` block is injected automatically — no manual file reads needed
- Use \`plumb_remember\` to store new facts for future sessions
- Use \`plumb_search\` for targeted mid-reasoning lookups
- Write dated backup logs to memory/YYYY-MM-DD.md (human-readable logbook — NOT a retrieval source)
`;

const SECTION_MARKER = '## Plumb Memory';

/**
 * Detect the workspace directory from common locations.
 * Returns the first directory that exists on disk.
 */
export function detectWorkspaceDir(ctxWorkspaceDir?: string): string | null {
  const candidates = [
    ctxWorkspaceDir,
    join(homedir(), '.openclaw', 'workspace'),
    join(homedir(), 'workspace'),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    if (existsSync(dir)) {
      return dir;
    }
  }

  return null;
}

/**
 * Append a section to a file if that section isn't already present.
 * Returns true if the file was patched, false if skipped (already present or file missing).
 */
function appendSectionIfMissing(
  filePath: string,
  sectionContent: string,
  label: string,
  logger: PatcherLogger
): boolean {
  if (!existsSync(filePath)) {
    logger.debug?.(`[plumb] ${label} not found at ${filePath} — skipping`);
    return false;
  }

  const existing = readFileSync(filePath, 'utf-8');
  if (existing.includes(SECTION_MARKER)) {
    logger.debug?.(`[plumb] ${label} already has ${SECTION_MARKER} section — skipping`);
    return false;
  }

  appendFileSync(filePath, sectionContent, 'utf-8');
  logger.info(`[plumb] Patched ${label} with Plumb memory instructions`);
  return true;
}

/**
 * Patch AGENTS.md and MEMORY.md in the workspace directory to add Plumb instructions.
 * Safe to call multiple times — idempotent (checks for existing ## Plumb Memory section).
 * Runs fully async and never throws; all errors are caught and logged.
 *
 * @param workspaceDir Path to workspace directory (may be undefined if not yet detected)
 * @param logger Plugin logger for info/warn/debug output
 */
export async function patchWorkspaceFiles(
  workspaceDir: string | undefined,
  logger: PatcherLogger
): Promise<void> {
  try {
    const dir = detectWorkspaceDir(workspaceDir);
    if (!dir) {
      logger.debug?.('[plumb] No workspace directory found — skipping file patching');
      return;
    }

    const agentsMd = join(dir, 'AGENTS.md');
    const memoryMd = join(dir, 'MEMORY.md');

    appendSectionIfMissing(agentsMd, AGENTS_MD_SECTION, 'AGENTS.md', logger);
    appendSectionIfMissing(memoryMd, MEMORY_MD_SECTION, 'MEMORY.md', logger);
  } catch (err) {
    logger.warn(`[plumb] workspace-patcher error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
