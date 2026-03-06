/**
 * Manages the Plumb memory integration section in CLAUDE.md.
 * Pure function for testability - takes existing content, returns updated content.
 */

const START_MARKER = '<!-- plumb:managed -->';
const END_MARKER = '<!-- /plumb:managed -->';

/**
 * The prescriptive CLAUDE.md section that instructs Claude Code
 * to use Plumb memory tools automatically.
 */
function getPlumbSection(): string {
  return `${START_MARKER}
# Plumb Memory Integration

**REQUIRED BEHAVIOR — ALWAYS FOLLOW THESE RULES:**

## Session Start (MANDATORY)
- At the beginning of EVERY session, you MUST call \`memory_search\` with a description of the current task, project, or user question
- Example: \`memory_search({ query: "React authentication refactoring project" })\`
- NEVER skip this step, even for short sessions or simple questions
- Use the search results to inform your work and avoid repeating past mistakes

## During Work (REQUIRED)
- When you learn facts about user preferences, call \`memory_store\` immediately:
  - Code style preferences (e.g., "user prefers functional components over class components")
  - Project architecture decisions (e.g., "auth system uses JWT stored in httpOnly cookies")
  - Tool choices (e.g., "project uses pnpm, not npm")
  - Workflow preferences (e.g., "always run tests before committing")
- When you discover recurring patterns or solutions, call \`memory_store\`:
  - Bug fixes that required non-obvious steps
  - Configuration quirks or gotchas
  - Performance optimization patterns that worked

## Session End (REQUIRED)
- Before ending a session, you MUST call \`memory_store\` with:
  - Key decisions made during the session
  - Important changes or refactorings completed
  - Unresolved issues or blockers for future sessions
- Example: \`memory_store({ content: "Migrated auth system to use refresh tokens. Remaining: update mobile client to handle token rotation." })\`

## Tool Usage
- Use \`memory_search({ query: "..." })\` to retrieve relevant past context
- Use \`memory_store({ content: "..." })\` to save important information
- Use \`memory_status()\` to check memory system health
- Use \`memory_delete({ id: "..." })\` to remove outdated or incorrect entries

**This is not optional. These tools exist to preserve context across sessions. Use them.**
${END_MARKER}`;
}

/**
 * Updates or adds the Plumb section to CLAUDE.md content.
 *
 * @param existingContent - Current CLAUDE.md content (undefined if file doesn't exist)
 * @returns Updated CLAUDE.md content with Plumb section
 */
export function updateClaudeMd(existingContent: string | undefined): string {
  const plumbSection = getPlumbSection();

  // If no existing content, return just the Plumb section
  if (!existingContent) {
    return plumbSection + '\n';
  }

  // Check if markers exist
  const startIndex = existingContent.indexOf(START_MARKER);
  const endIndex = existingContent.indexOf(END_MARKER);

  // If both markers exist, replace the content between them
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const before = existingContent.substring(0, startIndex);
    const after = existingContent.substring(endIndex + END_MARKER.length);
    return before + plumbSection + after;
  }

  // If markers don't exist or are malformed, append the section
  // Add newlines to separate from existing content
  const separator = existingContent.endsWith('\n\n') ? '' : existingContent.endsWith('\n') ? '\n' : '\n\n';
  return existingContent + separator + plumbSection + '\n';
}
