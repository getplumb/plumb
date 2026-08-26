// A deliberately small YAML frontmatter reader and writer.
//
// Scope is the frontmatter Plumb itself writes and the simple key/value blocks
// found in hand-authored memory files: scalars, inline `[a, b]` lists, and
// `- item` block lists. It is not a YAML parser and does not pretend to be.
//
// Anything it cannot parse is returned as `null` rather than guessed at, and
// callers treat that as "no frontmatter" and keep the raw text as the body.
// Guessing here would silently corrupt a user's existing notes during a
// migration, which is the one operation where that is least recoverable.

export function splitFrontmatter(raw) {
  const text = String(raw ?? '')
  if (!text.startsWith('---')) return { data: null, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: null, body: text }
  const block = text.slice(text.indexOf('\n') + 1, end)
  const body = text.slice(text.indexOf('\n', end + 1) + 1)
  const data = parseBlock(block)
  return { data, body: data === null ? text : body }
}

function parseScalar(value) {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (/^\[.*\]$/.test(trimmed)) {
    return trimmed.slice(1, -1).split(',').map((v) => stripQuotes(v.trim())).filter(Boolean)
  }
  return stripQuotes(trimmed)
}

const stripQuotes = (v) =>
  (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v

function parseBlock(block) {
  const data = {}
  const lines = block.split('\n')
  let currentKey = null
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const listItem = /^\s+-\s+(.*)$/.exec(line)
    if (listItem && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = []
      data[currentKey].push(stripQuotes(listItem[1].trim()))
      continue
    }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!pair) {
      // Nested maps and anything else exotic: refuse rather than mangle.
      if (/^\s+\S/.test(line) && currentKey) continue
      return null
    }
    currentKey = pair[1]
    const value = pair[2]
    data[currentKey] = value.trim() === '' ? [] : parseScalar(value)
  }
  return data
}

export function formatFrontmatter(data) {
  const lines = ['---']
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      if (key === 'tags') {
        lines.push(`${key}: [${value.join(', ')}]`)
      } else {
        lines.push(`${key}:`)
        for (const item of value) lines.push(`  - ${item}`)
      }
    } else {
      const text = String(value)
      lines.push(`${key}: ${/[:#]/.test(text) ? JSON.stringify(text) : text}`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}

export function formatPage(frontmatter, body) {
  return `${formatFrontmatter(frontmatter)}\n\n${String(body).trim()}\n`
}
