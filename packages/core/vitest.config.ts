import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The cross-session integration test loads an ML embedding model on first
    // run (Xenova/bge-small-en-v1.5 download + WASM init) which can take >5s
    // in CI. Give it enough headroom without masking genuine hangs.
    testTimeout: 60_000,
  },
});
