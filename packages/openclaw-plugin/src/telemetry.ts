/**
 * Plumb anonymous telemetry.
 *
 * Fires two events to PostHog:
 *   - plugin_installed  — once per machine (sentinel file: ~/.plumb/.telemetry-id)
 *   - plugin_activated  — every time the plugin activates (for active-install tracking)
 *
 * What is sent: plugin version, OS platform, CPU arch. No PII, no file paths,
 * no user content ever.
 *
 * Opt-out: set PLUMB_TELEMETRY=0 in your environment.
 * Documented in README.md under "Telemetry".
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Injected at build time via esbuild define — see esbuild.config.mjs
const POSTHOG_KEY = process.env.POSTHOG_KEY as string;
const POSTHOG_HOST = 'https://us.i.posthog.com';
const SENTINEL_DIR = join(homedir(), '.plumb');
const SENTINEL_FILE = join(SENTINEL_DIR, '.telemetry-id');

/** Read or create a stable anonymous machine ID. */
async function getMachineId(): Promise<string> {
  if (existsSync(SENTINEL_FILE)) {
    try {
      return (await readFile(SENTINEL_FILE, 'utf-8')).trim();
    } catch {
      // Fall through to create a new one
    }
  }
  const id = randomUUID();
  try {
    await mkdir(SENTINEL_DIR, { recursive: true });
    await writeFile(SENTINEL_FILE, id, { flag: 'wx' }); // wx = fail if exists (race-safe)
  } catch {
    // Already created by concurrent process, or dir not writable — just use in-memory id
  }
  return id;
}

async function capture(event: string, distinctId: string, properties: Record<string, unknown>): Promise<void> {
  await fetch(`${POSTHOG_HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: POSTHOG_KEY,
      event,
      distinct_id: distinctId,
      properties: {
        ...properties,
        $lib: 'plumb-plugin',
      },
    }),
  });
}

/**
 * Fire telemetry on plugin activation. Call from activate(), fire-and-forget.
 * Checks PLUMB_TELEMETRY=0 opt-out before doing anything.
 */
export async function fireTelemetry(version: string): Promise<void> {
  if (process.env.PLUMB_TELEMETRY === '0') return;

  const distinctId = await getMachineId();
  const props = {
    version,
    platform: process.platform,
    arch: process.arch,
  };

  // plugin_activated — every activation (tracks active installs over time)
  await capture('plugin_activated', distinctId, props);

  // plugin_installed — only if this is the first time we've seen this machine
  // The sentinel file is created by getMachineId() above; if writeFile with 'wx'
  // succeeded (no EEXIST), this is a fresh install. We detect that by checking
  // if the file was just created (mtime within last 5 seconds).
  try {
    const { mtimeMs } = await import('node:fs/promises').then(fs => fs.stat(SENTINEL_FILE));
    if (Date.now() - mtimeMs < 5000) {
      await capture('plugin_installed', distinctId, props);
    }
  } catch {
    // Sentinel file not readable — skip plugin_installed event
  }
}
