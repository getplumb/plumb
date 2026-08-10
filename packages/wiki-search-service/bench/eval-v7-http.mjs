// v7 search-surface evaluator (2026-08-07). Extends the v4-v6.1
// eval-console-fast-search-phase.mjs pattern (same production searchWiki call,
// process-isolated per phase so the navigator's module-level cache/index state
// cannot leak across configurations) onto:
//   - the new pinned snapshot (real-wiki/artifacts/v7-snapshot-20260807/wiki.db)
//   - cases/challenge.train.v7.json (157 cases: 102 re-anchored v6.1 + 4 new strata)
//   - success@k=2 with a documented deterministic reformulation retry
//   - should-not-inject noise@5 (search-recall proxy; see caveat in output)
//   - budget-gate pass/fail (injection p95 < 1000ms, search p95 < 300ms)
//   - critical-case gate pass/fail (2026-08-08): any case authored with `critical: true`
//     that misses its required expected page(s) on a single-shot query flips
//     summary.criticalGate.criticalGatePass to false, per requiredPageMode logic
//     (default 'all'). Implements the previously-aspirational "no critical production
//     regression case fails" gate from current-wiki-rag-evaluation-plan.md section 9.
//
// Usage: node eval-v7.mjs <phase> <outFile>
//   phase fast-bm25   : WIKI_SEARCH_MODE=fast, vector half skipped -> BM25-only
//   phase fast-hybrid  : WIKI_SEARCH_MODE=fast-hybrid, guards open -> full hybrid
//
// Caveat (documented, not hidden): searchWiki is the shared retrieval backend for
// both the injection and agent-mcp-search/console-search surfaces per the v6.1
// surface model (injection queries with Clay's raw last message; agent-mcp-search/
// console-search query it directly). This script measures that shared retrieval
// layer's page-list quality and latency. It cannot observe the separate downstream
// injection confidence/abstention gate (wiki-injection.ts, not imported here per
// the read-only-wikiNavigator.js constraint), so should-not-inject "noise@5" here
// means "how many pages this retrieval layer would hand the gate to filter," not
// "how often the gate itself abstains." Same-page stale-vs-current snippet
// discrimination (temporalCorrectnessPass) needs chunk-level scoring; that is run
// separately via `src/cli.ts run` (results-caseset-v7-baseline-20260807/context-assembly-*).
import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const [phase, outFile] = process.argv.slice(2)
const DB = '/home/openclaw-host/.openclaw/workspace/plumb-benchmark/real-wiki/artifacts/v7-snapshot-20260807/wiki.db'
const CASES = process.env.EVAL_CASES_FILE
  || '/home/openclaw-host/.openclaw/workspace/plumb-benchmark/real-wiki/cases/challenge.train.v7.json'

// HTTP-adapter variant (2026-08-09): identical scoring to eval-v7.mjs, but
// retrieval goes over HTTP to a spawned instance of the extracted
// @getplumb/wiki-search-service instead of importing terra-chat's module
// in-process. Latency figures therefore INCLUDE the local HTTP round-trip,
// which is what production consumers will actually experience.
import { spawn } from 'node:child_process'

const SERVICE_ENTRY = new URL('../src/server.js', import.meta.url).pathname
const serviceEnv = { ...process.env, PORT: '0', WIKI_DB_PATH: DB, WIKI_ROOT: DB.replace(/wiki\.db$/, 'wiki') }
if (phase === 'fast-bm25') {
  serviceEnv.WIKI_SEARCH_MODE = 'fast'
} else if (phase === 'fast-hybrid') {
  serviceEnv.WIKI_SEARCH_MODE = 'fast-hybrid'
  serviceEnv.WIKI_SEARCH_FAST_GUARD_BYTES = '99999999999'
} else {
  console.error('unknown phase (expected fast-bm25 | fast-hybrid)', phase)
  process.exit(1)
}

const service = spawn(process.execPath, [SERVICE_ENTRY], { env: serviceEnv, stdio: ['ignore', 'pipe', 'inherit'] })
const servicePort = await new Promise((resolvePromise, rejectPromise) => {
  const timer = setTimeout(() => rejectPromise(new Error('service did not start')), 20000)
  let buffer = ''
  service.stdout.on('data', data => {
    buffer += data.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        const entry = JSON.parse(line)
        if (entry.event === 'listening') { clearTimeout(timer); resolvePromise(entry.port) }
      } catch { /* non-JSON noise */ }
    }
  })
  service.once('exit', code => { clearTimeout(timer); rejectPromise(new Error(`service exited: ${code}`)) })
})
process.on('exit', () => service.kill())

const nav = {
  async searchWiki(query, _db, topK) {
    const response = await fetch(`http://127.0.0.1:${servicePort}/search?q=${encodeURIComponent(query)}&topK=${topK}`)
    if (!response.ok) throw new Error(`search HTTP ${response.status}`)
    return response.json()
  },
}
const parsed = JSON.parse(readFileSync(CASES, 'utf8'))
const cases = Array.isArray(parsed) ? parsed : parsed.cases

// Deterministic reformulation strategy for success@k=2: entity-only retry. Strips a
// fixed stopword/function-word list and question scaffolding, keeping capitalized /
// quoted / hyphenated tokens and remaining content words, deduped, in original order.
// This models a cheap, mechanical second attempt (no LLM call), not a smarter agent.
const STOPWORDS = new Set(['a','an','the','is','was','are','were','did','does','do','what','which','who','how','why','when',
  'to','of','in','on','for','with','and','or','that','this','it','my','me','i','you','your','clay','can','could','would',
  'should','if','still','right','now','again','ever','actually','just','really','currently','about','from','at','as','be',
  'been','has','have','had','will','shall','not','no','yes','ok','okay','so','then','there','their','they','he','she','we'])
function reformulate(query) {
  const tokens = query.replace(/[?!.,]/g, ' ').split(/\s+/).filter(Boolean)
  const kept = tokens.filter(t => {
    const bare = t.replace(/^["'([]+|["')\]]+$/g, '')
    if (!bare) return false
    if (/^[A-Z]/.test(bare) || bare.includes('-') || /^\d/.test(bare)) return true
    return !STOPWORDS.has(bare.toLowerCase())
  })
  const deduped = [...new Set(kept.map(t => t.replace(/^["'([]+|["')\]]+$/g, '')))]
  return deduped.join(' ').trim()
}

const rows = []
const warmupStart = performance.now()
await nav.searchWiki('evaluation warmup priming query', DB, 5)
const warmupMs = performance.now() - warmupStart

for (const testCase of cases) {
  const expected = testCase.expectedPages || []
  const hardNegatives = testCase.hardNegativePages || []
  const isNoInject = Boolean(testCase.expectNoAnswer || testCase.shouldInject === false)

  const t0 = performance.now()
  const result1 = await nav.searchWiki(testCase.query, DB, 5)
  const latencyMs = performance.now() - t0
  const top5 = result1.results.map(r => r.path)

  let usedReformulation = false
  let top5Attempt2 = null
  let latencyMs2 = null
  const anyExpectedAttempt1 = expected.length ? expected.some(p => top5.includes(p)) : null
  let successAtK2 = anyExpectedAttempt1

  if (expected.length && !anyExpectedAttempt1) {
    const reformulated = reformulate(testCase.query)
    if (reformulated && reformulated.toLowerCase() !== testCase.query.toLowerCase()) {
      usedReformulation = true
      const t1 = performance.now()
      const result2 = await nav.searchWiki(reformulated, DB, 5)
      latencyMs2 = performance.now() - t1
      top5Attempt2 = result2.results.map(r => r.path)
      successAtK2 = expected.some(p => top5Attempt2.includes(p))
    } else {
      successAtK2 = false
    }
  }

  const anyExpectedInTop5 = expected.length ? top5.some(p => expected.includes(p)) : null
  const allExpectedInTop5 = expected.length ? expected.every(p => top5.includes(p)) : null

  // Critical-case page-retrieval gate (v7.1): a case authored with `critical: true` is a
  // must-pass production regression case (e.g. a personal fact lookup that failed live),
  // not just another averaged data point. Pass/fail follows the exact same requiredPageMode
  // logic already used for scoring ('all' unless the case opts into 'any', see
  // src/metrics.ts's `requiredMode = c.criteria?.requiredPageMode ?? 'all'`), evaluated on
  // the single-shot attempt1 top5 (no reformulation credit) since the real regression this
  // targets was a single-shot injection/search miss, not a retryable one.
  const isCritical = Boolean(testCase.critical)
  const requiredPageMode = testCase.criteria?.requiredPageMode ?? 'all'
  const criticalPagePass = isCritical && expected.length
    ? (requiredPageMode === 'any' ? anyExpectedInTop5 : allExpectedInTop5)
    : null

  rows.push({
    id: testCase.id,
    category: testCase.category,
    querySurface: testCase.querySurface ?? null,
    messageShape: testCase.messageShape ?? null,
    isNoInject,
    mode: result1.mode,
    latencyMs,
    top5,
    anyExpectedInTop5,
    allExpectedInTop5,
    expectedCount: expected.length,
    hardNegativesInTop5: hardNegatives.filter(p => top5.includes(p)).length,
    noiseAt5: isNoInject ? top5.length : null,
    usedReformulation,
    reformulatedQuery: usedReformulation ? reformulate(testCase.query) : null,
    latencyMs2,
    successAtK2: expected.length ? successAtK2 : null,
    critical: isCritical,
    criticalPagePass,
  })
}

function pct(sortedArr, q) { return sortedArr.length ? sortedArr[Math.min(sortedArr.length - 1, Math.floor(q * sortedArr.length))] : null }
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null }
function rate(arr, pred) { const scoped = arr.filter(r => pred(r) !== null); return scoped.length ? scoped.filter(pred).length / scoped.length : null }

const answerable = rows.filter(r => r.expectedCount > 0)
const noInject = rows.filter(r => r.isNoInject)
const injectionRows = answerable.filter(r => r.querySurface === 'injection')
const questionRows = injectionRows.filter(r => r.messageShape === 'question')
const taskRows = injectionRows.filter(r => r.messageShape === 'task')
const agentSearchRows = answerable.filter(r => r.querySurface === 'agent-mcp-search')
const consoleSearchRows = answerable.filter(r => r.querySurface === 'console-search')
const temporalRows = answerable.filter(r => r.category === 'temporal-staleness')

const anyExp = (arr) => arr.length ? arr.filter(r => r.anyExpectedInTop5).length / arr.length : null
const allExp = (arr) => arr.length ? arr.filter(r => r.allExpectedInTop5).length / arr.length : null
const succK2 = (arr) => arr.length ? arr.filter(r => r.successAtK2).length / arr.length : null
const latP95 = (arr) => pct([...arr.map(r => r.latencyMs)].sort((a, b) => a - b), 0.95)
const latMean = (arr) => mean(arr.map(r => r.latencyMs))

const questionAny = anyExp(questionRows), taskAny = anyExp(taskRows)
const injectionWeightedAny = (questionAny !== null && taskAny !== null) ? 0.63 * questionAny + 0.37 * taskAny : null
const agentSearchAny = anyExp(agentSearchRows)
const headlineWeighted = (injectionWeightedAny !== null && agentSearchAny !== null)
  ? 0.70 * injectionWeightedAny + 0.30 * agentSearchAny : null

const criticalRows = rows.filter(r => r.critical)
const criticalFailureRows = criticalRows.filter(r => r.criticalPagePass === false)

const BUDGET_INJECTION_P95_MS = 1000
const BUDGET_SEARCH_P95_MS = 300
const injectionP95 = latP95(injectionRows.length ? injectionRows : answerable)
const searchP95 = latP95([...agentSearchRows, ...consoleSearchRows])

const summary = {
  phase,
  warmupMs: Math.round(warmupMs),
  mode: rows[0]?.mode,
  caseCount: rows.length,
  answerableCount: answerable.length,
  noInjectCount: noInject.length,
  headline: {
    weightedAggregateAnyExpected5: headlineWeighted,
    weights: { injection: 0.70, agentMcpSearch: 0.30, withinInjection: { question: 0.63, task: 0.37 } },
  },
  perSurface: {
    injectionWeightedAnyExpected5: injectionWeightedAny,
    injectionQuestionAnyExpected5: questionAny,
    injectionTaskAnyExpected5: taskAny,
    injectionAllExpected5: allExp(injectionRows),
    agentMcpSearchAnyExpected5: agentSearchAny,
    agentMcpSearchAllExpected5: allExp(agentSearchRows),
    consoleSearchAnyExpected5: anyExp(consoleSearchRows),
    consoleSearchAllExpected5: allExp(consoleSearchRows),
  },
  successAtK2: {
    injection: succK2(injectionRows),
    agentMcpSearch: succK2(agentSearchRows),
    consoleSearch: succK2(consoleSearchRows),
    overallAnswerable: succK2(answerable),
    reformulationUsedRate: mean(answerable.map(r => r.usedReformulation ? 1 : 0)),
  },
  temporalStaleness: {
    n: temporalRows.length,
    anyExpected5: anyExp(temporalRows),
    note: 'Page-level search proxy only (current-fact page retrieval). Snippet-level stale-vs-current discrimination (temporalCorrectnessPass) is scored separately via src/cli.ts run using criteria.expectedCurrentEvidenceHashes/staleEvidenceHashes wired on 6 of these 15 cases.',
  },
  shouldNotInject: {
    n: noInject.length,
    meanNoiseAt5: mean(noInject.map(r => r.noiseAt5)),
    zeroResultRate: noInject.length ? noInject.filter(r => r.noiseAt5 === 0).length / noInject.length : null,
    note: 'Search-recall proxy: mean count of pages this retrieval layer returns for should-not-inject queries. Not a measurement of the downstream injection confidence/abstention gate (out of scope per read-only wikiNavigator.js constraint).',
  },
  latency: {
    overallMean: latMean(rows), overallP95: pct([...rows.map(r => r.latencyMs)].sort((a, b) => a - b), 0.95),
    injectionMean: latMean(injectionRows), injectionP95,
    searchMean: latMean([...agentSearchRows, ...consoleSearchRows]), searchP95,
  },
  budgetGates: {
    injectionP95UnderMs: BUDGET_INJECTION_P95_MS,
    injectionP95ActualMs: injectionP95,
    injectionGatePass: injectionP95 !== null ? injectionP95 < BUDGET_INJECTION_P95_MS : null,
    searchP95UnderMs: BUDGET_SEARCH_P95_MS,
    searchP95ActualMs: searchP95,
    searchGatePass: searchP95 !== null ? searchP95 < BUDGET_SEARCH_P95_MS : null,
  },
  criticalGate: {
    note: 'Enforces the evaluation plan\'s "no critical production regression case fails" hard gate (see current-wiki-rag-evaluation-plan.md section 9) on cases authored with `critical: true`. criticalGatePass is false if ANY critical case misses its required expected page(s) on a single-shot query (no reformulation-retry credit); a fresh run failing this gate is a blocking regression, not just a lower averaged score.',
    criticalCaseCount: criticalRows.length,
    criticalCaseIds: criticalRows.map(r => r.id),
    failingCriticalCaseIds: criticalFailureRows.map(r => r.id),
    criticalGatePass: criticalRows.length ? criticalFailureRows.length === 0 : null,
  },
}

writeFileSync(outFile, JSON.stringify({ summary, rows }, null, 1))
console.log(JSON.stringify(summary, null, 2))
process.exit(0)
