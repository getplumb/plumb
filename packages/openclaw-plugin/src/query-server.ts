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

interface QueryRequest {
  query: string;
  topK?: number;
}

interface QueryResponse {
  results: Array<{
    chunk_text: string;
    session_id: string;
    session_label: string | null;
    timestamp: string;
    final_score: number;
  }>;
  latencyMs: number;
}

/**
 * Start the query server on loopback (127.0.0.1).
 * Returns the server instance for later shutdown.
 */
export function startQueryServer(store: LocalStore, port: number, logger?: { info: (msg: string) => void }): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
        const results = await store.searchRawLog(parsed.query, topK);
        const latencyMs = performance.now() - startMs;

        const response: QueryResponse = {
          results: results.map((r) => ({
            chunk_text: r.chunk_text,
            session_id: r.session_id,
            session_label: r.session_label,
            timestamp: r.timestamp,
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
    server.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}
