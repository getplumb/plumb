// Overload characterization for plumb-wiki-search. Fires far more traffic than
// the real consumers ever will (injection hook + MCP + console ≈ 1-3 concurrent)
// and reports how the service degrades: error rate, latency percentiles, RSS.
// Every query is unique to defeat the result cache; that forces a real embed +
// full BM25+vector scoring pass per request, which is the honest worst case.
const BASE = process.env.TARGET || 'http://127.0.0.1:18795'

// Deliberately generic. This list only has to produce unique multi-word
// queries, so the words themselves carry no meaning -- and the version that
// did, harvested from a real personal wiki, put private life terms and named
// third parties into a public repository.
const VOCAB = ('plumb benchmark retrieval contextual embedding coverage catalog interview loop feedback vector index '
  + 'program pipeline snapshot scan cadence stream ingest dictation gateway teardown archive console navigation '
  + 'linear cron migration search outreach cascade adapter shard replica roles wiki queue worker dream lint '
  + 'sharding data quality script relocation locale ledger tenant schema contractor gateway extension').split(' ')

let queryCounter = 0
function uniqueQuery(words = 4) {
  queryCounter += 1
  const picked = Array.from({ length: words }, (_, i) => VOCAB[(queryCounter * 7 + i * 13) % VOCAB.length])
  return `${picked.join(' ')} probe ${queryCounter}`
}

function percentile(sorted, q) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null
}

async function timedGet(path) {
  const started = performance.now()
  try {
    const response = await fetch(`${BASE}${path}`)
    await response.arrayBuffer()
    return { ms: performance.now() - started, status: response.status }
  } catch (error) {
    return { ms: performance.now() - started, status: 0, error: String(error) }
  }
}

async function runPhase(name, totalRequests, concurrency, pathFor) {
  const latencies = []
  const statuses = new Map()
  let inFlight = 0
  let dispatched = 0
  const phaseStart = performance.now()
  await new Promise((resolvePhase) => {
    const pump = () => {
      while (inFlight < concurrency && dispatched < totalRequests) {
        dispatched += 1
        inFlight += 1
        timedGet(pathFor()).then(({ ms, status }) => {
          latencies.push(ms)
          statuses.set(status, (statuses.get(status) || 0) + 1)
          inFlight -= 1
          if (latencies.length === totalRequests) resolvePhase()
          else pump()
        })
      }
    }
    pump()
  })
  const wallMs = performance.now() - phaseStart
  const sorted = [...latencies].sort((a, b) => a - b)
  const summary = {
    phase: name,
    requests: totalRequests,
    concurrency,
    wallMs: Math.round(wallMs),
    throughputRps: Math.round((totalRequests / wallMs) * 1000 * 10) / 10,
    p50: Math.round(percentile(sorted, 0.5)),
    p95: Math.round(percentile(sorted, 0.95)),
    p99: Math.round(percentile(sorted, 0.99)),
    max: Math.round(sorted[sorted.length - 1]),
    statuses: Object.fromEntries(statuses),
  }
  console.log(JSON.stringify(summary))
  return summary
}

async function health() {
  const response = await fetch(`${BASE}/health`)
  const body = await response.json()
  return { rssMb: Math.round(body.rssBytes / 1024 / 1024), embedder: body.stats.embedder, mode: body.stats.searchMode }
}

console.log(JSON.stringify({ phase: 'health-before', ...(await health()) }))

// 1. Sequential warm baseline: what a single well-behaved consumer sees.
await runPhase('sequential-baseline', 100, 1, () => `/search?q=${encodeURIComponent(uniqueQuery())}&topK=5`)

// 2. Concurrency ladder, all unique queries.
for (const concurrency of [10, 50, 100]) {
  await runPhase(`ladder-c${concurrency}`, concurrency * 10, concurrency, () => `/search?q=${encodeURIComponent(uniqueQuery())}&topK=5`)
}

// 3. Single burst: everything at once.
await runPhase('burst-500', 500, 500, () => `/search?q=${encodeURIComponent(uniqueQuery())}&topK=5`)

// 4. Hostile inputs under concurrency: oversized queries and absurd topK.
await runPhase('hostile-inputs', 200, 50, () => {
  const junk = `${uniqueQuery(3)} ${'x'.repeat(10_000)}`
  return `/search?q=${encodeURIComponent(junk)}&topK=999999`
})

// 5. Mixed realistic endpoints under load.
await runPhase('mixed-endpoints', 300, 30, () => {
  const roll = queryCounter % 3
  if (roll === 0) return `/search?q=${encodeURIComponent(uniqueQuery())}&topK=5`
  if (roll === 1) return '/tree'
  return `/page?path=${encodeURIComponent('glossary.md')}`
})

console.log(JSON.stringify({ phase: 'health-after', ...(await health()) }))
