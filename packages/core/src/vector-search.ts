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
