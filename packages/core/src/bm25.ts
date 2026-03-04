/**
 * BM25 Okapi — pure TypeScript in-memory implementation.
 *
 * Parameters: k1 = 1.5, b = 0.75 (standard values from the original paper).
 * IDF variant: Robertson-Walker smooth IDF to avoid negative values for
 * very common terms: IDF(q) = log((N - df + 0.5) / (df + 0.5) + 1)
 *
 * Usage:
 *   const index = new Bm25(corpus);     // corpus: string[]
 *   const scores = index.scores(query); // scores: number[], same order as corpus
 */

const K1 = 1.5;
const B = 0.75;

/** Tokenize text to lowercase alphanumeric tokens. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/\b[a-z0-9]+\b/g) ?? [];
}

export class Bm25 {
  readonly #n: number;
  readonly #avgdl: number;
  readonly #idf: Map<string, number>;
  readonly #tf: Array<Map<string, number>>;
  readonly #docLengths: number[];

  constructor(corpus: readonly string[]) {
    this.#n = corpus.length;
    const tokenized = corpus.map(tokenize);
    this.#docLengths = tokenized.map((t) => t.length);
    const totalLen = this.#docLengths.reduce((a, b) => a + b, 0);
    this.#avgdl = this.#n > 0 ? totalLen / this.#n : 1;

    // Build term-frequency maps and document-frequency counts.
    const df = new Map<string, number>();
    this.#tf = tokenized.map((tokens) => {
      const freq = new Map<string, number>();
      for (const tok of tokens) {
        freq.set(tok, (freq.get(tok) ?? 0) + 1);
      }
      for (const tok of freq.keys()) {
        df.set(tok, (df.get(tok) ?? 0) + 1);
      }
      return freq;
    });

    // Precompute IDF for each unique term.
    this.#idf = new Map();
    const N = this.#n;
    for (const [term, dfTerm] of df) {
      this.#idf.set(term, Math.log((N - dfTerm + 0.5) / (dfTerm + 0.5) + 1));
    }
  }

  /**
   * Compute BM25 scores for all corpus documents against the query.
   * Returns an array of scores in the same order as the constructor corpus.
   */
  scores(query: string): number[] {
    const queryTerms = tokenize(query);
    const result = new Array<number>(this.#n).fill(0);

    if (queryTerms.length === 0 || this.#n === 0) return result;

    for (const term of queryTerms) {
      const idf = this.#idf.get(term);
      if (idf === undefined) continue;

      for (let i = 0; i < this.#n; i++) {
        const tf = this.#tf[i]?.get(term) ?? 0;
        if (tf === 0) continue;
        const dl = this.#docLengths[i] ?? 0;
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * dl / this.#avgdl));
        result[i] = (result[i] ?? 0) + idf * norm;
      }
    }

    return result;
  }
}
