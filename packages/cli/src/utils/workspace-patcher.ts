import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Content to append to AGENTS.md if ## Plumb Memory section doesn't exist
 */
const AGENTS_MD_CONTENT = `
## Plumb Memory
- \`[PLUMB MEMORY]\` block is injected automatically before each response — no manual file reads needed
- Use \`plumb_remember("fact")\` to store new facts for future sessions (stored in ~/.plumb/memory.db)
- Use \`plumb_search("query")\` for targeted mid-reasoning lookups
- Write dated backup logs to memory/YYYY-MM-DD.md (human-readable record for Clay, NOT a memory source)
- Do NOT rewrite MEMORY.md as primary memory — Plumb owns retrieval; MEMORY.md is for hard invariants only
`;

/**
 * Content to append to MEMORY.md if ## Plumb Memory section doesn't exist
 */
const MEMORY_MD_CONTENT = `
## Plumb Memory
- \`[PLUMB MEMORY]\` block is injected automatically — no manual file reads needed
- Use \`plumb_remember\` to store new facts for future sessions
- Use \`plumb_search\` for targeted mid-reasoning lookups
`;

/**
 * Check if a file already contains a ## Plumb Memory section
 */
function hasPlumbMemorySection(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return /^##\s+Plumb\s+Memory/im.test(content);
  } catch {
    return false;
  }
}

/**
 * Patch workspace files (AGENTS.md, MEMORY.md) with Plumb Memory sections.
 * Only patches files that exist and don't already have the section.
 *
 * @param workspaceDir Path to the workspace directory
 * @returns Object indicating which files were patched
 */
export async function patchWorkspaceFiles(workspaceDir: string): Promise<{
  agentsMd: boolean;
  memoryMd: boolean;
}> {
  const result = { agentsMd: false, memoryMd: false };

  // Check and patch AGENTS.md
  const agentsMdPath = join(workspaceDir, 'AGENTS.md');
  if (existsSync(agentsMdPath) && !hasPlumbMemorySection(agentsMdPath)) {
    try {
      appendFileSync(agentsMdPath, AGENTS_MD_CONTENT, 'utf-8');
      result.agentsMd = true;
    } catch (err) {
      // Silently fail - non-fatal
    }
  }

  // Check and patch MEMORY.md
  const memoryMdPath = join(workspaceDir, 'MEMORY.md');
  if (existsSync(memoryMdPath) && !hasPlumbMemorySection(memoryMdPath)) {
    try {
      appendFileSync(memoryMdPath, MEMORY_MD_CONTENT, 'utf-8');
      result.memoryMd = true;
    } catch (err) {
      // Silently fail - non-fatal
    }
  }

  return result;
}
