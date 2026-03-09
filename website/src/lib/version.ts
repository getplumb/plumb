// Version is sourced directly from the OpenClaw plugin package.json.
// To bump: run `npm version <patch|minor|major>` in packages/openclaw-plugin.
// The badge on the website will update automatically on next build/deploy.
//
// Pre-1.0: displays "v0.4.17" style
// At 1.0+: displays "v1.0" (major.minor only, no patch)
import pluginPkg from "../../../packages/openclaw-plugin/package.json";

export const PLUGIN_VERSION: string = pluginPkg.version;

/** Badge-friendly display version.
 *  0.x.y → "v0.x.y"
 *  1.x.y → "v1.x" (drops patch — "v1.0" looks cleaner than "v1.0.0")
 */
export function displayVersion(v: string): string {
  const [major, minor] = v.split(".");
  if (Number(major) >= 1) return `v${major}.${minor}`;
  return `v${v}`;
}
