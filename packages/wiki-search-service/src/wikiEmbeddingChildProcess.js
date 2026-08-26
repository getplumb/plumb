// Resident embedding process for fast wiki search mode.
//
// Runs as a child process rather than a worker thread because onnxruntime-node's
// native binding fails with "Module did not self-register" when loaded inside
// worker_threads (the failure mode that silently disabled vector search in the
// per-query worker design). A fresh process loads it reliably.
//
// Protocol: JSON lines. stdin: {"id": 1, "query": "..."}. stdout: {"ready": true}
// once the model is loaded, then {"id": 1, "vector": [...]} or {"id": 1, "error": "..."}.
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const [transformerEntry, model] = process.argv.slice(2)
const { pipeline, env } = await import(pathToFileURL(transformerEntry).href)
env.allowLocalModels = true
env.backends.onnx.wasm.numThreads = 1
const embeddingPipeline = await pipeline('feature-extraction', model)
process.stdout.write(`${JSON.stringify({ ready: true })}\n`)

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (!line.trim()) continue
  let id = null
  try {
    const message = JSON.parse(line)
    id = message.id
    const output = await embeddingPipeline(`query: ${message.query}`, { pooling: 'mean', normalize: true })
    process.stdout.write(`${JSON.stringify({ id, vector: Array.from(output.data) })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) })}\n`)
  }
}
