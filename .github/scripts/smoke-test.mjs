/**
 * smoke-test.mjs
 *
 * Exercises the Plumb plugin after a fresh npm install — no openclaw process
 * required. Uses LocalStore from @getplumb/core (the real public API) to:
 *
 *   1. Plugin + core import without error
 *   2. DB initializes (better-sqlite3 native addon loaded + schema created)
 *   3. Ingest a fact
 *   4. Search and retrieve it
 *   5. Status reflects the write
 *   6. Cleanup
 */

import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const smokeDir = process.env.PLUMB_SMOKE_DIR ?? join(tmpdir(), 'plumb-smoke-test');
const dbPath = process.env.PLUMB_DB_PATH ?? join(smokeDir, '.plumb-test', 'memory.db');

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function main() {
  console.log('\n🔬 Plumb smoke test\n');
  console.log(`  smokeDir : ${smokeDir}`);
  console.log(`  dbPath   : ${dbPath}`);
  console.log(`  node     : ${process.version}`);
  console.log(`  platform : ${process.platform}\n`);

  // Ensure DB directory exists
  mkdirSync(dbPath.replace(/[/\\][^/\\]+$/, ''), { recursive: true });

  // --- 1. Import @getplumb/core ---
  let LocalStore;
  try {
    const core = await import(join(smokeDir, 'node_modules', '@getplumb', 'core', 'dist', 'index.js'));
    LocalStore = core.LocalStore;
    assert('@getplumb/core imports without error', !!LocalStore);
  } catch (err) {
    assert('@getplumb/core imports without error', false, err.message);
    bail();
  }

  // --- 2. DB initializes (LocalStore.create is the async factory) ---
  let store;
  try {
    store = await LocalStore.create({ dbPath, userId: 'smoke-test' });
    assert('DB initializes via LocalStore.create()', true);
  } catch (err) {
    assert('DB initializes via LocalStore.create()', false, err.message);
    bail();
  }

  // --- 3. Ingest a fact ---
  const testContent = `smoke-test — platform=${process.platform} node=${process.version}`;
  try {
    await store.ingestMemoryFact({
      content: testContent,
      sourceSessionId: 'smoke-test-session',
      tags: ['smoke-test'],
      confidence: 0.9,
      decayRate: 'slow',
    });
    assert('ingestMemoryFact()', true);
  } catch (err) {
    assert('ingestMemoryFact()', false, err.message);
  }

  // --- 4. Search retrieves it ---
  try {
    const results = await store.searchMemoryFacts('smoke-test', 5);
    const found = results.some(r => r.content?.includes('smoke-test'));
    assert('searchMemoryFacts() retrieves ingested fact', found, `got ${results.length} result(s)`);
  } catch (err) {
    assert('searchMemoryFacts() retrieves ingested fact', false, err.message);
  }

  // --- 5. Status reflects the write ---
  try {
    const status = await store.status();
    assert('status() shows factCount >= 1', status.factCount >= 1, `factCount=${status.factCount}`);
  } catch (err) {
    assert('status() reflects write', false, err.message);
  }

  // --- 6. Cleanup ---
  try {
    store.close();
    rmSync(dbPath.replace(/[/\\][^/\\]+$/, ''), { recursive: true, force: true });
    assert('Cleanup test DB', true);
  } catch (err) {
    assert('Cleanup test DB', false, err.message);
  }

  // --- Summary ---
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

function bail() {
  console.error('\n  Fatal: cannot continue smoke test.\n');
  process.exit(1);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
