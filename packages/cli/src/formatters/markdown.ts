import type { RawFact, RawLogEntry } from '@getplumb/core';

/**
 * Format facts as human-readable Markdown.
 * Groups facts by subject, shows all predicates and objects for each subject.
 */
export function formatFactsMarkdown(facts: readonly RawFact[]): string {
  if (facts.length === 0) {
    return '# Plumb Facts Export\n\nNo facts found.\n';
  }

  // Group facts by subject.
  const bySubject = new Map<string, RawFact[]>();
  for (const fact of facts) {
    const existing = bySubject.get(fact.subject) ?? [];
    existing.push(fact);
    bySubject.set(fact.subject, existing);
  }

  let markdown = '# Plumb Facts Export\n\n';
  markdown += `**Total facts:** ${facts.length}\n\n`;

  // Sort subjects alphabetically.
  const subjects = Array.from(bySubject.keys()).sort();

  for (const subject of subjects) {
    const subjectFacts = bySubject.get(subject)!;
    markdown += `## ${subject}\n\n`;

    for (const fact of subjectFacts) {
      const deletedBadge = fact.deleted ? ' **[DELETED]**' : '';
      const timestamp = new Date(fact.timestamp);
      const daysAgo = Math.floor((Date.now() - timestamp.getTime()) / (1000 * 60 * 60 * 24));
      const timeLabel = daysAgo === 0 ? 'today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;

      markdown += `### ${fact.predicate} → ${fact.object}${deletedBadge}\n\n`;
      markdown += `- **Confidence:** ${fact.confidence.toFixed(2)}\n`;
      markdown += `- **Decay rate:** ${fact.decayRate}\n`;
      markdown += `- **Session:** ${fact.sourceSessionLabel ?? fact.sourceSessionId}\n`;
      markdown += `- **Timestamp:** ${timestamp.toISOString()} (${timeLabel})\n`;
      if (fact.context) {
        markdown += `- **Context:** ${fact.context}\n`;
      }
      markdown += '\n';
    }
  }

  return markdown;
}

/**
 * Format raw log entries as human-readable Markdown.
 * Each exchange is a section showing user message, agent response, session, and timestamp.
 */
export function formatRawLogMarkdown(entries: readonly RawLogEntry[]): string {
  if (entries.length === 0) {
    return '# Plumb Raw Log Export\n\nNo log entries found.\n';
  }

  let markdown = '# Plumb Raw Log Export\n\n';
  markdown += `**Total entries:** ${entries.length}\n\n`;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const timestamp = new Date(entry.timestamp);
    const daysAgo = Math.floor((Date.now() - timestamp.getTime()) / (1000 * 60 * 60 * 24));
    const timeLabel = daysAgo === 0 ? 'today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;

    markdown += `## Exchange ${i + 1}: ${entry.sessionLabel ?? entry.sessionId}\n\n`;
    markdown += `**Source:** ${entry.source} | **Timestamp:** ${timestamp.toISOString()} (${timeLabel})\n\n`;

    markdown += '### User\n\n';
    markdown += `${entry.userMessage}\n\n`;

    markdown += '### Agent\n\n';
    markdown += `${entry.agentResponse}\n\n`;

    markdown += '---\n\n';
  }

  return markdown;
}
