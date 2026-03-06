import { LocalStore } from '@getplumb/core';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { getDefaultDbPath } from '../utils/db-path.js';

export interface StatusOptions {
  /** Path to the database file. Defaults to ~/.plumb/memory.db */
  db?: string;
  /** Print JSON to stdout instead of human-readable format */
  json?: boolean;
  /** User ID to show status for. Defaults to 'default' */
  userId?: string;
  /** Print full fact list */
  verbose?: boolean;
}

/**
 * Check if the MCP server binary is installed.
 * Returns the path if found, null otherwise.
 */
function checkMcpServer(): string | null {
  try {
    // Try to find plumb-mcp in PATH
    const result = execFileSync('which', ['plumb-mcp'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    // Not found
    return null;
  }
}

/**
 * Format bytes to human-readable size (KB/MB/GB).
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format timestamp to human-readable age (e.g., "2 hours ago").
 */
function formatAge(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  return `${seconds} second${seconds !== 1 ? 's' : ''} ago`;
}

/**
 * Format number with thousands separator (e.g., 1,247).
 */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Status command handler.
 * Two modes:
 *   1. plumb status         → prints human-readable summary
 *   2. plumb status --json  → prints structured JSON to stdout
 */
export async function statusCommand(options: StatusOptions): Promise<void> {
  const dbPath = options.db ?? getDefaultDbPath();
  const userId = options.userId ?? 'default';

  // Check if database exists.
  if (!existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`);
    console.error('No Plumb data found. Start using Plumb to build your memory.');
    process.exit(1);
  }

  // Open LocalStore and gather status data.
  const store = await LocalStore.create({ dbPath, userId });
  const status = await store.status();
  const topSubjects = store.topSubjects(userId, 5);
  store.close();

  // Check MCP server installation.
  const mcpServerPath = checkMcpServer();

  // Mode 1: --json flag → print JSON to stdout.
  if (options.json) {
    const jsonOutput = {
      factCount: status.factCount,
      rawLogCount: status.rawLogCount,
      lastIngestion: status.lastIngestion?.toISOString() ?? null,
      storageBytes: status.storageBytes,
      topSubjects,
      mcpServer: {
        installed: mcpServerPath !== null,
        path: mcpServerPath,
      },
    };
    console.log(JSON.stringify(jsonOutput, null, 2));
    return;
  }

  // Mode 2: default → print human-readable summary.
  console.log('Plumb Memory — Local Store');
  console.log('──────────────────────────');
  console.log(`Facts:          ${formatNumber(status.factCount)}`);
  console.log(`Raw log:        ${formatNumber(status.rawLogCount)} exchange${status.rawLogCount !== 1 ? 's' : ''}`);
  console.log(`Last ingestion: ${status.lastIngestion ? formatAge(status.lastIngestion) : 'never'}`);
  console.log(`Storage:        ${formatBytes(status.storageBytes)}`);
  console.log();

  if (topSubjects.length > 0) {
    console.log('Top subjects:');
    for (const { subject, count } of topSubjects) {
      // Pad subject name to align counts (max 20 chars)
      const paddedSubject = subject.padEnd(20);
      console.log(`  ${paddedSubject} (${formatNumber(count)} fact${count !== 1 ? 's' : ''})`);
    }
    console.log();
  }

  if (mcpServerPath) {
    console.log(`MCP server:     installed (${mcpServerPath})`);
  } else {
    console.log('MCP server:     not found (run npm install -g @plumb/mcp-server)');
  }

  // --verbose: print all facts from the DB
  if (options.verbose && status.factCount > 0) {
    console.log();
    console.log('Facts:');
    console.log('──────────────────────────');
    const verboseStore = await LocalStore.create({ dbPath, userId });
    const results = await verboseStore.search('', status.factCount);
    verboseStore.close();

    // Sort by timestamp descending (most recent first)
    const sorted = [...results].sort(
      (a, b) => b.fact.timestamp.getTime() - a.fact.timestamp.getTime()
    );

    for (const { fact } of sorted) {
      const conf = (fact.confidence * 100).toFixed(0);
      const age = formatAge(fact.timestamp);
      console.log(`  ${fact.subject} ${fact.predicate} ${fact.object}`);
      console.log(`    confidence: ${conf}% | decay: ${fact.decayRate} | ${age}`);
      if (fact.context) console.log(`    context: ${fact.context}`);
      console.log();
    }
  }
}
