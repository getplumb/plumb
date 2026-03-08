/**
 * e2e-test.mjs
 *
 * Verifies that the Plumb plugin loads correctly inside a running
 * openclaw gateway. Run after:
 *   1. openclaw plugins install <tarball>
 *   2. openclaw gateway run (background, health confirmed)
 *
 * What this catches that smoke tests don't:
 *   - Plugin crashes during gateway initialization (the Cannot read
 *     properties of undefined class of bugs)
 *   - Plugin fails to register in the openclaw plugin loader
 *   - postinstall artifacts missing at runtime (better-sqlite3 binaries, etc.)
 *   - Plugin listed as "error" or "disabled" in live gateway state
 */

import { execSync } from 'node:child_process';

const port = process.env.OPENCLAW_PORT ?? '18789';
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
  console.log('\n🦞 OpenClaw E2E test\n');
  console.log(`  port     : ${port}`);
  console.log(`  node     : ${process.version}`);
  console.log(`  platform : ${process.platform}\n`);

  // ── 1. Gateway health ────────────────────────────────────────────────────
  let health;
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    health = await res.json();
    assert('Gateway /health returns ok', health?.ok === true, JSON.stringify(health));
  } catch (err) {
    assert('Gateway /health returns ok', false, err.message);
    bail();
  }

  // ── 2. Plugin list ───────────────────────────────────────────────────────
  let plumb;
  try {
    const raw = execSync('openclaw plugins list --json 2>/dev/null', { encoding: 'utf8' });
    // Strip any leading non-JSON (e.g. plugin activation log lines)
    const jsonStart = raw.indexOf('{');
    if (jsonStart === -1) throw new Error('No JSON object in output');
    const data = JSON.parse(raw.slice(jsonStart));
    plumb = data.plugins?.find(p => p.id === 'plumb');
    assert('plumb plugin is listed', !!plumb, plumb ? '' : 'id "plumb" not found in plugin list');
  } catch (err) {
    assert('openclaw plugins list runs without error', false, err.message);
    bail();
  }

  // ── 3. Plugin status ─────────────────────────────────────────────────────
  // "loaded" = plugin module found + loaded by openclaw, not crashed
  // "active" = running in a live gateway session (may vary by openclaw version)
  // Anything other than "error" / "disabled" is acceptable here.
  const badStatuses = ['error', 'crashed', 'disabled', 'not-found'];
  assert(
    'plumb plugin status is not error/disabled',
    !badStatuses.includes(plumb?.status),
    `status=${plumb?.status}`
  );

  assert(
    'plumb plugin is enabled',
    plumb?.enabled === true,
    `enabled=${plumb?.enabled}`
  );

  // ── 4. Hooks registered ──────────────────────────────────────────────────
  // plumb registers a pre-response hook — verify it shows up
  // Note: toolNames may be empty in CLI static view; hookNames reflects
  // what was registered at load time.
  const hooks = plumb?.hookNames ?? [];
  const hasPreResponse = hooks.some(h => h === 'pre-response' || h.includes('pre'));
  // Non-fatal: hooks may surface differently depending on openclaw version
  if (hasPreResponse) {
    assert('plumb pre-response hook registered', true);
  } else {
    console.log(`  ℹ️  hookNames=${JSON.stringify(hooks)} (may be populated only in live gateway)`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

function bail() {
  console.error('\n  Fatal: cannot continue E2E test.\n');
  process.exit(1);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
