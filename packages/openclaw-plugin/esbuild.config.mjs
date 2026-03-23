import { build } from 'esbuild';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// esbuild plugin to replace llm-client imports with stub
const llmClientStubPlugin = {
  name: 'llm-client-stub',
  setup(build) {
    build.onResolve({ filter: /\/llm-client\.js$/ }, (args) => {
      // Redirect all imports ending in /llm-client.js to our stub
      return {
        path: resolve(__dirname, 'src/stubs/llm-client-stub.ts'),
      };
    });
  },
};

async function main() {
  // Build the bundled ESM file — bundle @getplumb/core and all its deps in
  await build({
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    // Replace LLM client with stub to eliminate all LLM network calls from bundle
    plugins: [llmClientStubPlugin],
    // Only keep true Node built-ins external (they're always available)
    external: [
      'node:*',
      // WASM SQLite — cannot be bundled, must be present in node_modules at runtime.
      'better-sqlite3',
      // LLM SDKs — externalized to keep them out of the bundle.
      // The plugin does not call any LLM APIs in this version (MVP).
      'openai',
      '@anthropic-ai/sdk',
      '@xenova/transformers',
      'sharp',
      'onnxruntime-node',
    ],
    // Replace all process.env reads with undefined at build time.
    // The plugin does not use LLM APIs in this MVP release — fact extraction
    // is disabled, so these env reads are dead code that esbuild will tree-shake.
    define: {
      // PostHog public analytics key — injected at build time (safe to embed in bundle)
      'process.env.POSTHOG_KEY': JSON.stringify('phc_zODHLfFXk0LZXbOn98Wd0i1BMg8QJT3P5LIortpGyut'),
      'process.env.OPENAI_API_KEY': 'undefined',
      'process.env.ANTHROPIC_API_KEY': 'undefined',
      'process.env.GEMINI_API_KEY': 'undefined',
      'process.env.PLUMB_LLM_PROVIDER': 'undefined',
      'process.env.PLUMB_LLM_MODEL': 'undefined',
      'process.env.PLUMB_LLM_BASE_URL': 'undefined',
      'process.env.OLLAMA_HOST': 'undefined',
      'process.env.PLUMB_EXTRACT_INTERVAL_MS': 'undefined',
      'process.env.PLUMB_EXTRACT_BATCH_SIZE': 'undefined',
      'process.env.PLUMB_EXTRACT_ITEM_DELAY_MS': 'undefined',
      'process.env.PLUMB_QUERY_PORT': 'undefined',
    },
    loader: {
      '.wasm': 'copy',
    },
    // Resolve workspace packages from the monorepo root node_modules
    nodePaths: [resolve(__dirname, '../../node_modules')],
    sourcemap: true,
    minify: false,
  });

  // Generate TypeScript declarations
  console.log('Generating TypeScript declarations...');
  execSync('tsc --emitDeclarationOnly --declaration --declarationMap', { stdio: 'inherit' });

  console.log('Build complete!');
}

main().catch((error) => {
  console.error('Build failed:', error);
  process.exit(1);
});
