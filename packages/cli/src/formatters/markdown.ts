import type { RawLogEntry } from '@getplumb/core';

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
