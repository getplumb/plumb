#!/usr/bin/env node
/**
 * postinstall.mjs — rebuild better-sqlite3 native addon after install.
 *
 * better-sqlite3 is a native Node.js addon bundled with @getplumb/plumb via
 * bundledDependencies. The tarball contains source but the compiled binary
 * (.node) is platform/Node-ABI-specific and must be built on first install.
 *
 * This script is a no-op when:
 *   - better-sqlite3 is not in our own node_modules (e.g., inside a pnpm workspace)
 *   - the binary already exists and loads correctly
 *
 * Otherwise it runs `npm rebuild better-sqlite3` to compile/download the binary.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(__dirname, '..');
const sqliteDir = join(pluginDir, 'node_modules', 'better-sqlite3');

// Only run if better-sqlite3 is in our own node_modules (bundled install).
// In a pnpm workspace, it lives in the root .pnpm store, not here.
if (!existsSync(sqliteDir)) {
  process.exit(0);
}

// Check if the binary already exists
const binaryPath = join(sqliteDir, 'build', 'Release', 'better_sqlite3.node');
if (existsSync(binaryPath)) {
  // Try to actually load it to verify ABI compatibility
  try {
    const req = createRequire(import.meta.url);
    req(join(sqliteDir, 'lib', 'index.js'));
    process.exit(0); // Binary exists and loads — nothing to do
  } catch {
    console.log('[plumb] better-sqlite3 binary found but incompatible with Node ' + process.versions.node + ', rebuilding...');
  }
}

console.log('[plumb] Building better-sqlite3 for Node.js v' + process.versions.node + '...');

const opts = { cwd: pluginDir, timeout: 120_000 };

try {
  execSync('npm rebuild better-sqlite3', { ...opts, stdio: 'pipe' });
  console.log('[plumb] better-sqlite3 built successfully.');
} catch (err) {
  console.warn('[plumb] Warning: could not build better-sqlite3 native addon.');
  console.warn('[plumb] The Plumb memory plugin may fail to load.');
  console.warn('[plumb] To fix: cd ' + pluginDir + ' && npm rebuild better-sqlite3');
  console.warn('[plumb] Requires: gcc/clang + python3 + node-gyp');
  // Exit 0 — do not fail the parent install
}
