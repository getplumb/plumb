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

if (failed) process.exit(1)
console.log(`Gate scope matches the publishable set (${[...GATED].sort().join(', ')}).`)
// Whether those filters actually SELECT anything is asserted by the workflow,
// which checks turbo's task count on the real run -- see 'ran no tasks' there.
