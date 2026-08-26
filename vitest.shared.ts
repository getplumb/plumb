import { defineConfig } from 'vitest/config';

// One source of truth for test runner settings across every package.
//
// This started life inside packages/core, where it was written to survive CI.
// Nothing propagated it, so the other five vitest packages kept vitest's 5s
// default and its default parallel pool -- and the first cross-platform CI run
// failed exactly where this config predicts: timeouts in wiki, wiki-worker and
// mcp-server on macOS runners, which are slower than the Linux box these tests
// were tuned on.
export default defineConfig({
  test: {
    // Tests that touch retrieval load an ML embedding model on first run
    // (Xenova/bge-small-en-v1.5 download + WASM init), which routinely exceeds
    // 5s on a cold CI runner. Generous, but not so generous it masks a hang.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Run sequentially in one worker. Multiple workers each loading the ~130MB
    // ONNX model causes OOM and worker crashes on memory-constrained runners
    // (Windows GitHub Actions in particular).
    //
    // This was `poolOptions.forks.singleFork` until now. Vitest 4 removed
    // poolOptions and moved everything top-level, so that setting had been
    // silently inert since the v4 upgrade -- the OOM protection an earlier
    // commit added for Windows CI was not actually in force. vitest printed a
    // DEPRECATED warning about it, which nothing was reading because these
    // suites had never run in CI.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
