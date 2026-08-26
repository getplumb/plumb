/**
 * Lightweight HTTP query endpoint for RAG latency testing.
 *
 * Exposes POST /query on loopback (127.0.0.1) only.
 * No auth — loopback isolation is sufficient.
 *
 * Uses Node's built-in http module to avoid bundle bloat.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { LocalStore } from '@getplumb/core';
import type { LifecycleIdentity } from './lifecycle-lease.js';

interface QueryRequest {
  query: string;
  topK?: number;
}

interface QueryResponse {
  results: Array<{
    content: string;
    source_session_id: string;
    source_session_label: string | null;
    created_at: string;
    tags: readonly string[] | null;
    final_score: number;
  }>;
  latencyMs: number;
}

export type QueryServerIdentity = {
  identityHash: string;
  ownerId: string;
  startedAt: string;
  identity: LifecycleIdentity;
};

/**
 * Start the query server on loopback (127.0.0.1).
 * Returns the server instance for later shutdown.
 */
export function startQueryServer(
  store: LocalStore,
  port: number,
  logger?: { info: (msg: string) => void },
  serverIdentity?: QueryServerIdentity,
): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'plumb-query',
        identityHash: serverIdentity?.identityHash ?? null,
        pid: process.pid,
        ownerId: serverIdentity?.ownerId ?? null,
        startedAt: serverIdentity?.startedAt ?? null,
        identity: serverIdentity?.identity ?? null,
      }));
      return;
    }

    // Only accept POST /query
    if (req.method !== 'POST' || req.url !== '/query') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. Use POST /query' }));
      return;
    }

    // Parse JSON body
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const parsed: QueryRequest = JSON.parse(body);

        if (!parsed.query || typeof parsed.query !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid "query" field' }));
          return;
        }

        const topK = parsed.topK ?? 10;

        // Execute search and measure latency
        const startMs = performance.now();
        const results = await store.searchMemoryFacts(parsed.query, topK);
        const latencyMs = performance.now() - startMs;

        const response: QueryResponse = {
          results: results.map((r) => ({
            content: r.content,
            source_session_id: r.source_session_id,
            source_session_label: r.source_session_label,
            created_at: r.created_at,
            tags: r.tags,
            final_score: r.final_score,
          })),
          latencyMs,
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (err: unknown) {
        // Malformed JSON → 400
        if (err instanceof SyntaxError) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }

        // Any other error → 500
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error', message: String(err) }));
      }
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger?.info(`[plumb] ERROR: Port ${port} is already in use. Configure a different queryPort in plugin settings.`);
    } else {
      logger?.info(`[plumb] Query server error: ${err.message}`);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger?.info(`[plumb] Query server listening on http://127.0.0.1:${port}/query`);
  });

  return server;
}

/**
 * Gracefully shut down the query server.
 */
export function stopQueryServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err: NodeJS.ErrnoException | undefined) => {
      if (err) {
        if (err.code === 'ERR_SERVER_NOT_RUNNING') {
          resolve();
          return;
        }
        reject(err);
      } else {
        resolve();
      }
    });
  });
}
