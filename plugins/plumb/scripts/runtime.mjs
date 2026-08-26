// Shared plumbing for the plugin's entry points.
//
// The engine is a real npm package with a ~78MB native dependency, so the
// plugin cannot vendor it -- a git-cloned plugin directory has no node_modules
// and the ONNX runtime is platform-specific. Instead `/plumb-setup` installs it
// into ${CLAUDE_PLUGIN_DATA}, which the plugin reference designates for exactly
// this ("persistent data, installed dependencies, caches"), and these shims
// resolve it at run time.
//
// The consequence to design around: between installing the plugin and running
// /plumb-setup, the runtime is absent. That window must produce a clear
// instruction, never a stack trace on every prompt.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PACKAGE_NAME = '@getplumb/wiki-search-service'

export function runtimeDir(argv = process.argv) {
  const flag = argv.indexOf('--runtime')
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1]
  if (process.env.PLUMB_RUNTIME_DIR) return process.env.PLUMB_RUNTIME_DIR
  // Matches ${CLAUDE_PLUGIN_DATA} for a plugin named "plumb". Only reached when
  // a script is run by hand, outside the plugin's own wiring.
  return join(homedir(), '.claude', 'plugins', 'data', 'plumb')
}

export function entryPoint(name, dir = runtimeDir()) {
  return join(dir, 'node_modules', PACKAGE_NAME, 'src', name)
}

export function isInstalled(dir = runtimeDir()) {
  return existsSync(entryPoint('server.js', dir))
}

/**
 * Plugin user config reaches hook processes as CLAUDE_PLUGIN_OPTION_<KEY>, and
 * MCP servers through .mcp.json env substitution. Normalise both into the
 * variables the engine actually reads, so the engine needs no knowledge of
 * Claude Code.
 *
 * Blank is treated as unset throughout: an unconfigured plugin option arrives
 * as an empty string, and the engine's own `||` defaults handle it from there.
 */
export function applyUserConfig(env = process.env) {
  const take = (...names) => {
    for (const name of names) {
      const value = env[name]
      if (value !== undefined && value !== '') return value
    }
    return undefined
  }

  const wikiRoot = take('CLAUDE_PLUGIN_OPTION_WIKI_ROOT', 'WIKI_ROOT')
  if (wikiRoot) {
    env.WIKI_ROOT = wikiRoot
    // The index travels with the corpus it describes, so a relocated wiki does
    // not silently keep answering from the old machine-wide database. It goes
    // *inside* the wiki directory rather than beside it: the parent of a
    // user-chosen folder is not ours to write to, and defaulting there would
    // drop a wiki.db into whatever directory happened to contain their notes.
    if (!take('WIKI_DB_PATH')) env.WIKI_DB_PATH = join(wikiRoot, '.wiki.db')
  }

  const serviceUrl = take('CLAUDE_PLUGIN_OPTION_SERVICE_URL', 'PLUMB_WIKI_SERVICE_URL')
  if (serviceUrl) env.PLUMB_WIKI_SERVICE_URL = serviceUrl

  const idleMinutes = take('CLAUDE_PLUGIN_OPTION_IDLE_TIMEOUT_MINUTES', 'PLUMB_WIKI_IDLE_MINUTES')
  if (idleMinutes !== undefined && Number.isFinite(Number(idleMinutes))) {
    // 0 means "stay resident", which the engine spells as an idle timeout of 0.
    env.PLUMB_WIKI_IDLE_TIMEOUT_MS = String(Math.round(Number(idleMinutes) * 60_000))
  }

  return env
}

export function notInstalledMessage(dir = runtimeDir()) {
  return (
    `Plumb's search engine is not installed yet. Run /plumb-setup to install it ` +
    `(expected at ${join(dir, 'node_modules', PACKAGE_NAME)}).`
  )
}
