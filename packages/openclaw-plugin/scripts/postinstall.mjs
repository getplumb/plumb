#!/usr/bin/env node
/**
 * postinstall.mjs — ensure better-sqlite3 native addon is ready after install.
 *
 * better-sqlite3 ships platform-specific prebuilt binaries via GitHub releases,
 * fetched by `prebuild-install`. We try that first (no build tools needed), then
 * fall back to `npm rebuild` (requires gcc/clang/MSVC + python3 + node-gyp).
 *
 * This script is a no-op when:
 *   - better-sqlite3 is not in our own node_modules (e.g., inside a pnpm workspace)
 *   - the binary already exists and loads correctly for the current Node ABI
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

// Check if the binary already exists and loads correctly.
const binaryPath = join(sqliteDir, 'build', 'Release', 'better_sqlite3.node');
if (existsSync(binaryPath)) {
  try {
    const req = createRequire(import.meta.url);
    req(join(sqliteDir, 'lib', 'index.js'));
    process.exit(0); // Binary exists and loads — nothing to do
  } catch {
    console.log('[plumb] better-sqlite3 binary found but incompatible with Node ' + process.versions.node + ', re-fetching...');
  }
}

console.log('[plumb] Fetching better-sqlite3 binary for Node.js v' + process.versions.node + ' / ' + process.platform + '-' + process.arch + '...');

// Find prebuild-install: better-sqlite3 lists it as a dependency, so it's
// either in better-sqlite3/node_modules/ or hoisted to our plugin root.
function findPrebuildInstall() {
  const candidates = [
    join(sqliteDir, 'node_modules', 'prebuild-install', 'bin.js'),
    join(pluginDir, 'node_modules', 'prebuild-install', 'bin.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

const prebuildScript = findPrebuildInstall();

if (prebuildScript) {
  try {
    execSync('node ' + JSON.stringify(prebuildScript), {
      cwd: sqliteDir,
      stdio: 'pipe',
      timeout: 90_000,
    });
    console.log('[plumb] better-sqlite3 prebuilt binary installed successfully.');
    process.exit(0);
  } catch (err) {
    console.log('[plumb] prebuild-install failed (' + (err.stderr?.toString().trim().split('\n')[0] ?? 'unknown error') + '), trying source build...');
  }
} else {
  console.log('[plumb] prebuild-install not found, trying source build...');
}

// Fall back to compiling from source (requires build tools).
try {
  execSync('npm rebuild better-sqlite3', { cwd: pluginDir, stdio: 'pipe', timeout: 120_000 });
  console.log('[plumb] better-sqlite3 built from source successfully.');
} catch (err) {
  console.warn('[plumb] Warning: could not obtain better-sqlite3 native addon.');
  console.warn('[plumb] The Plumb memory plugin may fail to load.');
  console.warn('[plumb] To fix manually: cd ' + pluginDir + ' && npm rebuild better-sqlite3');
  console.warn('[plumb] Requires: gcc/clang/MSVC + python3 + node-gyp');
  // Exit 0 — do not fail the parent install
}
