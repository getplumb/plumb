/**
 * JavaScript-based vector similarity search.
 *
 * Replaces sqlite-vec native extension with pure JS cosine similarity.
 * For current Plumb scale (thousands of facts, not millions), computing
 * cosine similarity in-memory is acceptable.
 */

export interface VectorSearchResult {
  readonly id: number;
  readonly distance: number;
}

/**
 * Compute cosine distance between two vectors.
 * Returns distance in [0, 2] where 0 = identical, 2 = opposite.
 * For normalized vectors, similarity = 1 - distance.
 */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same dimension');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  // Distance = 1 - similarity, scaled to [0, 2]
  return 1 - similarity;
}

/**
 * Find k-nearest neighbors in a vector corpus.
 *
 * @param queryVec Query embedding
 * @param corpus Array of [id, embedding] pairs
 * @param k Number of results to return
 * @returns Top-k results ordered by distance (ascending)
 */
export function knnSearch(
  queryVec: Float32Array,
  corpus: Array<{ id: number; embedding: Float32Array }>,
  k: number
): VectorSearchResult[] {
  // Compute distances for all vectors
  const distances = corpus.map(({ id, embedding }) => ({
    id,
    distance: cosineDistance(queryVec, embedding),
  }));

  // Sort by distance (ascending) and take top k
  distances.sort((a, b) => a.distance - b.distance);
  return distances.slice(0, k);
}

/**
 * Serialize embedding to JSON string for storage.
 */
export function serializeEmbedding(embedding: Float32Array): string {
  return JSON.stringify(Array.from(embedding));
}

/**
 * Deserialize embedding from JSON string.
 */
export function deserializeEmbedding(json: string): Float32Array {
  return new Float32Array(JSON.parse(json) as number[]);
}

/**
 * Serialize a wiki embedding as a raw float32 BLOB (2026-08-13).
 *
 * Wiki embeddings were stored as JSON text, which meant the search service had
 * to JSON.parse ~2,400 arrays of 384 numbers on every index rebuild. As a BLOB
 * the same data is `new Float32Array(buffer)` with no parsing: measured on a
 * copy, a full rebuild went from ~305ms to ~110ms.
 *
 * Deliberately NOT a change to serializeEmbedding above. That function is
 * shared with the memory system (local-store.ts writes vec_raw_log, and
 * memory-facts-search.ts reads it back through deserializeEmbedding, which
 * JSON.parses). Switching the shared function to BLOBs would hand a Buffer to
 * JSON.parse and break memory search. Only the two wiki writers use this one.
 *
 * The reader side (plumb-services/wiki-search decodeEmbedding) already accepts
 * both text and BLOB, so a half-migrated database stays fully readable and the
 * migration can stop at any point.
 *
 * Endianness note: this writes host byte order, which makes wiki.db
 * non-portable to a big-endian machine. Irrelevant on this x86 host; it matters
 * only for a restore onto different hardware.
 */
export function serializeWikiEmbeddingBlob(embedding: Float32Array): Uint8Array {
  const copy = new Float32Array(embedding);
  return new Uint8Array(copy.buffer, copy.byteOffset, copy.byteLength);
}
