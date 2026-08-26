// The CI gate covers what ships, and nothing else.
//
// It used to build and test every package under packages/, including retired
// ones. That is how @getplumb/openclaw-plugin -- private, unpublished, and
// decommissioned in August 2026 -- blocked a release it is not part of, with a
// genuine race in code that runs nowhere.
//
// Narrowing a gate is dangerous: done casually it is indistinguishable from
// switching off a test that found something. So the scope is asserted here
// rather than trusted. If a package is publishable it must be in the gate, and
// if it is in the gate it must be publishable. Adding a new publishable package
// and forgetting to gate it fails this check.
import { readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const GATED = new Set([
  '@getplumb/core',
  '@getplumb/wiki',
  '@getplumb/wiki-search-service',
  '@getplumb/wiki-worker',
  '@getplumb/plumb',
])

let failed = false
const seen = new Set()

for (const dir of readdirSync('packages')) {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8'))
  } catch {
    continue
  }
  const publishable = pkg.private !== true
  const gated = GATED.has(pkg.name)
  if (gated) seen.add(pkg.name)

  if (publishable && !gated) {
    console.error(`::error::${pkg.name} is publishable but is not in the CI gate. Add it to GATED in this script and to build:ci/test:ci in package.json.`)
    failed = true
  }
  if (!publishable && gated) {
    console.error(`::error::${pkg.name} is private but is in the CI gate. Remove it, or drop "private": true if it is meant to ship.`)
    failed = true
  }
}

for (const name of GATED) {
  if (!seen.has(name)) {
    console.error(`::error::${name} is in the CI gate but no package under packages/ declares that name.`)
    failed = true
  }
}

// And then prove the filters actually SELECT those packages on this platform.
//
// This check exists because the opposite happened and nobody noticed for five
// rounds. build:ci used --filter='./packages/*'. On Windows, pnpm runs scripts
// through cmd.exe, which does not strip single quotes, so the filter was the
// literal string "'./packages/*'", matched nothing, and turbo exited 0:
//
//     > turbo run test --filter='./packages/*' --concurrency=1
//      Tasks:    0 successful, 0 total
//
// Three Windows jobs per run built nothing, tested nothing, and reported
// success. A filter that matches nothing must never be mistaken for a pass.
let resolved
try {
  const out = execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['turbo', 'run', 'test', ...[...GATED].map((n) => `--filter=${n}`), '--dry=json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  resolved = new Set(JSON.parse(out).tasks.map((t) => t.package))
} catch (error) {
  console.error(`::error::Could not resolve the turbo filters: ${error.message}`)
  process.exit(1)
}

for (const name of GATED) {
  if (!resolved.has(name)) {
    console.error(`::error::Filter --filter=${name} selected nothing on ${process.platform}. The gate would run without it and still report success.`)
    failed = true
  }
}

if (failed) process.exit(1)
console.log(`Gate scope matches the publishable set, and all ${GATED.size} filters resolve on ${process.platform}: ${[...resolved].sort().join(', ')}.`)
