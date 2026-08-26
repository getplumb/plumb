#!/usr/bin/env node
// MCP server entry point.
//
// Unlike the hook, a missing runtime here should fail loudly: Claude Code
// surfaces a failed MCP server to the user, which is exactly the visibility we
// want, and there is no prompt to avoid blocking.
import { applyUserConfig, entryPoint, isInstalled, notInstalledMessage, runtimeDir } from './runtime.mjs'

const dir = runtimeDir()
applyUserConfig()

if (!isInstalled(dir)) {
  console.error(`[plumb] ${notInstalledMessage(dir)}`)
  process.exit(1)
}

await import(entryPoint('mcp-server.mjs', dir))
