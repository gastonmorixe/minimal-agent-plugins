/**
 * Locate a browser's `DevToolsActivePort` file.
 *
 * Pure except for an injected `exists` predicate (defaults to `fs.existsSync`),
 * so tests can assert the candidate ordering without touching the filesystem.
 *
 * @module lib/profile
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

/** Profile subpaths, relative to $HOME, in priority order. */
export const PROFILE_SUBPATHS = [
  "Library/Application Support/Chromium",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/BraveSoftware/Brave-Browser",
  "Library/Application Support/Microsoft Edge",
  ".config/chromium",
  ".config/google-chrome",
  ".config/microsoft-edge",
] as const

/** All candidate `DevToolsActivePort` absolute paths for a given home dir. */
export function candidateDtapPaths(home: string): string[] {
  return PROFILE_SUBPATHS.map((sub) => join(home, sub, "DevToolsActivePort"))
}

/**
 * Resolve the `DevToolsActivePort` path to use.
 *
 * Priority: explicit override (env) → first existing candidate. Throws a
 * helpful error naming the override env when nothing is found.
 */
export function resolveDtapPath(
  opts: { home: string; override?: string; exists?: (p: string) => boolean } = { home: "" },
): string {
  const exists = opts.exists ?? existsSync
  if (opts.override) return opts.override
  for (const c of candidateDtapPaths(opts.home)) {
    if (exists(c)) return c
  }
  throw new Error(
    "DevToolsActivePort not found in any known browser profile; " +
      "set CDP_DTAP=/path/to/DevToolsActivePort (launch Chrome with --remote-debugging-port first)",
  )
}
