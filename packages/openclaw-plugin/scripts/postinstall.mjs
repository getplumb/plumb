#!/usr/bin/env node

/**
 * Postinstall script for @getplumb/plumb OpenClaw plugin.
 *
 * Ensures better-sqlite3's native binary is built after installation.
 * This is required because bundledDependencies includes better-sqlite3 as source only,
 * and the install script doesn't re-run when extracted from the tarball.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const betterSqlite3Path = join(packageRoot, 'node_modules', 'better-sqlite3');

console.log('[plumb] Postinstall: checking better-sqlite3 native binary...');

// Check if better-sqlite3 is installed
if (!existsSync(betterSqlite3Path)) {
  console.log('[plumb] better-sqlite3 not found in node_modules, skipping rebuild');
  process.exit(0);
}

// Check if the binary already exists
const bindingPath = join(betterSqlite3Path, 'build', 'Release', 'better_sqlite3.node');
if (existsSync(bindingPath)) {
  console.log('[plumb] better-sqlite3 binary already exists, skipping rebuild');
  process.exit(0);
}

try {
  console.log('[plumb] Building better-sqlite3 native binary...');

  // Try node-gyp rebuild first (most reliable)
  try {
    execSync('npm run build-release', {
      cwd: betterSqlite3Path,
      stdio: 'inherit',
      env: { ...process.env, npm_config_build_from_source: 'true' }
    });
    console.log('[plumb] better-sqlite3 binary built successfully');
  } catch (buildError) {
    // Fallback to node-pre-gyp install (downloads prebuilt if available)
    console.log('[plumb] build-release failed, trying node-pre-gyp install...');
    execSync('npx node-pre-gyp install --fallback-to-build', {
      cwd: betterSqlite3Path,
      stdio: 'inherit'
    });
    console.log('[plumb] better-sqlite3 binary installed/built successfully');
  }
} catch (error) {
  console.error('[plumb] FATAL: Failed to build better-sqlite3 native binary');
  console.error('[plumb] The plugin will not function without this binary.');
  console.error('[plumb] Error:', error.message);
  console.error('[plumb]');
  console.error('[plumb] Please ensure you have build tools installed:');
  console.error('[plumb]   - macOS: xcode-select --install');
  console.error('[plumb]   - Windows: npm install --global windows-build-tools');
  console.error('[plumb]   - Linux: sudo apt-get install build-essential python3');
  process.exit(1);
}
