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

/** Embedding dimension for BAAI/bge-small-en-v1.5. */
export const EMBED_DIM = 384;

type Pipeline = (input: string | string[], opts?: Record<string, unknown>) => Promise<{ data: Float32Array }>;

let _embedPipeline: Pipeline | null = null;
let _embedLoadFailed = false;

async function getEmbedPipeline(): Promise<Pipeline | null> {
  if (_embedLoadFailed) return null;
  if (_embedPipeline === null) {
    try {
      // Dynamic import so the module is optional — if @xenova/transformers is not
      // installed (e.g. on Windows via openclaw plugins install --ignore-scripts),
      // we fall back to zero-vectors and skip embedding entirely.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — @xenova/transformers has incomplete typings
      const { pipeline, env } = await import('@xenova/transformers');
      (env as { allowLocalModels: boolean }).allowLocalModels = true;
      // Limit ONNX WASM to 1 thread so embedding doesn't peg all CPU cores.
      // Without this, Xenova spawns up to N worker threads (one per core),
      // making OpenClaw unusable during seeding or heavy ingest.
      // 1 thread = ~2–4× slower embeddings but the gateway stays responsive.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (env as any).backends.onnx.wasm.numThreads = 1;
      _embedPipeline = (await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5')) as Pipeline;
    } catch {
      _embedLoadFailed = true;
      return null;
    }
  }
  return _embedPipeline;
}

/**
 * Embed a passage for indexing (no query prefix).
 * Returns a normalized Float32Array of length EMBED_DIM.
 * Throws if @xenova/transformers is not available or embedding fails.
 */
export async function embed(text: string): Promise<Float32Array> {
  const pipe = await getEmbedPipeline();
  if (pipe === null) {
    throw new Error('Embedder not available: @xenova/transformers failed to load');
  }
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

/**
 * Embed a search query with BGE "query: " prefix.
 * Returns a normalized Float32Array of length EMBED_DIM, or a zero vector
 * if @xenova/transformers is not available (graceful degradation).
 */
export async function embedQuery(query: string): Promise<Float32Array> {
  const pipe = await getEmbedPipeline();
  if (pipe === null) return new Float32Array(EMBED_DIM);
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
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — @xenova/transformers has incomplete typings
      const { pipeline } = await import('@xenova/transformers');
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
 *
 * NOTE: Xenova/ms-marco-MiniLM-L-6-v2 via @xenova/transformers has a known
 * issue where it returns identical score=1 for all inputs regardless of
 * relevance (the pipeline treats the single relevance logit as a binary
 * classification and saturates via sigmoid). Until this is resolved with a
 * different model or library, we return all-zeros to trigger the RRF fallback,
 * which provides correct ranking via BM25+cosine fusion.
 */
export async function rerankScores(query: string, passages: string[]): Promise<number[]> {
  // Disabled: reranker produces degenerate scores (all 1.0) due to Xenova
  // pipeline compatibility issue with ms-marco cross-encoders.
  // RRF×recency (BM25 + cosine) fallback is used instead.
  return passages.map(() => 0);
}

/**
 * Warm the embedder pipeline at initialization time.
 * Loads and JIT-compiles the Xenova model to eliminate first-query cold-start latency.
 * No-op if @xenova/transformers is unavailable.
 */
export async function warmEmbedder(): Promise<void> {
  await getEmbedPipeline();
}

/**
 * Warm the reranker pipeline at initialization time.
 * Currently a no-op: reranker disabled due to Xenova ms-marco compatibility issue.
 * See rerankScores() comment for details.
 */
export async function warmReranker(): Promise<void> {
  // No-op: reranker disabled
}
