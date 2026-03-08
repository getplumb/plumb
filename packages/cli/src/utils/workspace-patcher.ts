import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Content to append to AGENTS.md when Plumb is first set up.
 * Instructs the agent how to use Plumb across sessions.
 * Keep in sync with packages/openclaw-plugin/src/workspace-patcher.ts
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
 * Content to append to MEMORY.md when Plumb is first set up.
 * Adds a brief Plumb reference to the hard-invariants file.
 * Keep in sync with packages/openclaw-plugin/src/workspace-patcher.ts
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
export function detectWorkspaceDir(envWorkspace?: string): string | null {
  const candidates = [
    envWorkspace ?? process.env['OPENCLAW_WORKSPACE'],
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

export interface PatchResult {
  /** true if AGENTS.md was found and patched (or already had the section) */
  agentsMd: boolean;
  /** true if MEMORY.md was found and patched (or already had the section) */
  memoryMd: boolean;
  /** true if AGENTS.md already had the Plumb section (skipped) */
  agentsMdSkipped: boolean;
  /** true if MEMORY.md already had the Plumb section (skipped) */
  memoryMdSkipped: boolean;
}

/**
 * Append Plumb memory sections to AGENTS.md and MEMORY.md in the workspace directory.
 * Idempotent — checks for existing ## Plumb Memory section before appending.
 * Never creates files; only patches existing ones.
 *
 * @param workspaceDir Optional workspace directory override. Falls back to OPENCLAW_WORKSPACE env / common locations.
 * @returns PatchResult indicating which files were found and patched
 */
export async function patchWorkspaceFiles(workspaceDir?: string): Promise<PatchResult> {
  const result: PatchResult = {
    agentsMd: false,
    memoryMd: false,
    agentsMdSkipped: false,
    memoryMdSkipped: false,
  };

  const dir = detectWorkspaceDir(workspaceDir);
  if (!dir) {
    return result;
  }

  const agentsMdPath = join(dir, 'AGENTS.md');
  const memoryMdPath = join(dir, 'MEMORY.md');

  if (existsSync(agentsMdPath)) {
    const content = readFileSync(agentsMdPath, 'utf-8');
    if (content.includes(SECTION_MARKER)) {
      result.agentsMd = true;
      result.agentsMdSkipped = true;
    } else {
      appendFileSync(agentsMdPath, AGENTS_MD_SECTION, 'utf-8');
      result.agentsMd = true;
    }
  }

  if (existsSync(memoryMdPath)) {
    const content = readFileSync(memoryMdPath, 'utf-8');
    if (content.includes(SECTION_MARKER)) {
      result.memoryMd = true;
      result.memoryMdSkipped = true;
    } else {
      appendFileSync(memoryMdPath, MEMORY_MD_SECTION, 'utf-8');
      result.memoryMd = true;
    }
  }

  return result;
}
