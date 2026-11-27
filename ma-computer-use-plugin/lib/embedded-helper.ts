/**
 * Extract the helper binary from a compiled CLI.
 *
 * A compiled CLI keeps the helper in its embedded plugin table, not on disk.
 * `pluginPackageFor(packageDir).execPath(HELPER_KEY)` writes it (mode 0755) to
 * `<packageDir>/native/build/ComputerUseHelper` and gives that path. That is
 * path 2 of `helperBinary`, so the normal lookup then finds it. A disk package
 * (a dev checkout or a disk-tier copy) and an embedded package with no helper
 * get the resolved path, and core writes nothing.
 *
 * @module lib/embedded-helper
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import { pluginPackageFor } from "@minimal-agent/core/host-kit/embedded-plugins"

/** The package path of the helper, the same as path 2 of `helperBinary`. */
export const HELPER_KEY = "native/build/ComputerUseHelper"

/** The result of {@link extractHelper}. It never throws. */
export type ExtractResult = { ok: true; path: string } | { ok: false; error: string }

/** Injectable effects of {@link extractHelper}. */
export interface ExtractDeps {
  /** The environment, for `CUD_HELPER`. Default: `process.env`. */
  env?: Record<string, string | undefined>
  /** Gives a disk path for `rel` in the package. Default: core `execPath`. */
  execPath?: (packageDir: string, rel: string) => string
  /** True when the path exists. Default: `existsSync`. */
  exists?: (path: string) => boolean
  /** Paths of earlier successes, by package dir. Default: one map for the process. */
  cache?: Map<string, string>
}

/** One success for each package dir, for this process. */
const extracted = new Map<string, string>()

/** Core `execPath`: extract the embedded file, or give the disk path. */
function defaultExecPath(packageDir: string, rel: string): string {
  return pluginPackageFor(packageDir).execPath(rel)
}

/**
 * Make sure that the helper of an embedded package is on disk.
 *
 * Order:
 * 1. `env.CUD_HELPER` is set: do nothing. `helperBinary` uses that path.
 * 2. An earlier success for `packageDir` and its file still exists: use it,
 *    so later calls skip the byte compare of core.
 * 3. Call `execPath(packageDir, HELPER_KEY)`. A throw (for example a home
 *    folder that cannot be written) gives `ok: false`.
 *
 * @param packageDir - The plugin folder (`ctx.packageDir`).
 * @param deps - Injectable effects. Tests set them.
 * @returns The path, or the error text.
 */
export function extractHelper(packageDir: string, deps: ExtractDeps = {}): ExtractResult {
  const env = deps.env ?? process.env
  if (env.CUD_HELPER) return { ok: true, path: env.CUD_HELPER }
  const cache = deps.cache ?? extracted
  const exists = deps.exists ?? existsSync
  const seen = cache.get(packageDir)
  if (seen !== undefined && exists(seen)) return { ok: true, path: seen }
  const execPath = deps.execPath ?? defaultExecPath
  try {
    const path = execPath(packageDir, HELPER_KEY)
    cache.set(packageDir, path)
    return { ok: true, path }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      error: `could not extract the helper to ${join(packageDir, HELPER_KEY)}: ${reason}`,
    }
  }
}
