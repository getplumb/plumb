import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The cross-session integration test loads an ML embedding model on first
    // run (Xenova/bge-small-en-v1.5 download + WASM init) which can take >5s
    // in CI. Give it enough headroom without masking genuine hangs.
    testTimeout: 60_000,
    // Run tests sequentially in a single fork. Multiple forks each loading
    // the ~130MB ONNX embedding model causes OOM/worker crashes on
    // memory-constrained CI runners (Windows GHA in particular).
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
