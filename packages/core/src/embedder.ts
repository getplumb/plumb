/**
 * Embedder — wraps @xenova/transformers for local CPU inference.
 *
 * Models:
 *   Passage embedder: Xenova/bge-small-en-v1.5 (384-dim, normalized cosine)
 *   Cross-encoder:    Xenova/ms-marco-MiniLM-L-6-v2 (relevance logit)
 *
 * BGE convention:
 *   - Index-time text: no prefix (raw passage)
 *   - Query-time text: "query: " prefix (improves asymmetric retrieval)
 *
 * First call downloads the model (~100 MB for bge-small). Subsequent calls
 * use the local cache at ~/.cache/huggingface/hub/.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — @xenova/transformers has incomplete typings
import { pipeline, env } from '@xenova/transformers';

/** Embedding dimension for BAAI/bge-small-en-v1.5. */
export const EMBED_DIM = 384;

// Disable the remote model check in test/offline environments to use cache.
// env.allowRemoteModels is already true by default; this line is a no-op but documents intent.
(env as { allowLocalModels: boolean }).allowLocalModels = true;

type Pipeline = (input: string | string[], opts?: Record<string, unknown>) => Promise<{ data: Float32Array }>;

let _embedPipeline: Pipeline | null = null;

async function getEmbedPipeline(): Promise<Pipeline> {
  if (_embedPipeline === null) {
    _embedPipeline = (await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5')) as Pipeline;
  }
  return _embedPipeline;
}

/**
 * Embed a passage for indexing (no query prefix).
 * Returns a normalized Float32Array of length EMBED_DIM.
 */
export async function embed(text: string): Promise<Float32Array> {
  const pipe = await getEmbedPipeline();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

/**
 * Embed a search query with BGE "query: " prefix.
 * Returns a normalized Float32Array of length EMBED_DIM.
 */
export async function embedQuery(query: string): Promise<Float32Array> {
  const pipe = await getEmbedPipeline();
  const output = await pipe(`query: ${query}`, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

// ─── Cross-encoder reranker ───────────────────────────────────────────────────

type RerankPipeline = (
  input: [string, string],
  opts?: Record<string, unknown>
) => Promise<Array<{ label: string; score: number }> | { label: string; score: number }>;

let _rerankPipeline: RerankPipeline | null = null;
let _rerankLoadFailed = false;

async function getRerankPipeline(): Promise<RerankPipeline | null> {
  if (_rerankLoadFailed) return null;
  if (_rerankPipeline === null) {
    try {
      _rerankPipeline = (await pipeline(
        'text-classification',
        'Xenova/ms-marco-MiniLM-L-6-v2',
      )) as RerankPipeline;
    } catch {
      _rerankLoadFailed = true;
      return null;
    }
  }
  return _rerankPipeline;
}

/**
 * Score (query, passage) pairs with the cross-encoder.
 * Returns raw logits (higher = more relevant).
 * Falls back to zeros if the reranker model is unavailable — callers
 * should detect all-zero arrays and fall back to RRF order.
 */
export async function rerankScores(query: string, passages: string[]): Promise<number[]> {
  const pipe = await getRerankPipeline();
  if (pipe === null || passages.length === 0) {
    return passages.map(() => 0);
  }

  const scores: number[] = [];
  for (const passage of passages) {
    try {
      const result = await pipe([query, passage], { function_to_apply: 'none' });
      const raw = (Array.isArray(result) ? result[0] : result) as { score: number } | undefined;
      scores.push(raw?.score ?? 0);
    } catch {
      scores.push(0);
    }
  }
  return scores;
}
