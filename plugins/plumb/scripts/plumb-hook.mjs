#!/usr/bin/env node
// UserPromptSubmit entry point.
//
// Delegates to the packaged injection hook once the runtime exists. Before that
// -- the window between installing the plugin and running /plumb-setup -- it
// says so once, then stays quiet. Failing open silently here would leave a
// user wondering why memory never works; failing loudly on every prompt would
// be worse.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyUserConfig, entryPoint, isInstalled, notInstalledMessage, runtimeDir } from './runtime.mjs'

const dir = runtimeDir()
applyUserConfig()

if (!isInstalled(dir)) {
  const statePath = join(homedir(), '.plumb', 'state', 'plugin-notice.json')
  const cooldownMs = 60 * 60 * 1000
  let notify = false
  try {
    let state = {}
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'))
    } catch {
      // First run, or unreadable state: treat as never notified.
    }
    if (Date.now() - (state.lastSetupNoticeAt ?? 0) >= cooldownMs) {
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, JSON.stringify({ ...state, lastSetupNoticeAt: Date.now() }))
      notify = true
    }
  } catch {
    // If the reminder cannot be rate limited, stay quiet rather than nag.
  }
  if (notify) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `[PLUMB WIKI]\n${notInstalledMessage(dir)}\n[/PLUMB WIKI]`,
        },
      }),
    )
  }
  process.exit(0)
}

try {
  await import(entryPoint('claude-code-hook.mjs', dir))
} catch (error) {
  // Never block a prompt. Record why, then get out of the way.
  try {
    const log = join(homedir(), '.plumb', 'logs', 'plugin-hook-errors.log')
    mkdirSync(dirname(log), { recursive: true })
    appendFileSync(log, `${new Date().toISOString()} ${error?.stack || error}\n`)
  } catch {
    // Logging is best effort.
  }
  process.exit(0)
}
