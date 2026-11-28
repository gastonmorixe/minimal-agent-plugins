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
 * Review H2: in a compiled CLI, a user-tier copy of this plugin (a disk
 * package) wins over the embedded one, and it has no built helper. Then the
 * helper of the EMBEDDED package of the same name is extracted and used.
 *
 * @module lib/embedded-helper
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import {
  embeddedPluginPackages,
  hasEmbeddedPlugins,
  pluginPackageFor,
} from "@minimal-agent/core/host-kit/embedded-plugins"
import { isStandaloneExecutable } from "@minimal-agent/core/plugin-api/utils/self-spawn"

/** The package path of the helper, the same as path 2 of `helperBinary`. */
export const HELPER_KEY = "native/build/ComputerUseHelper"

/**
 * True when the host is a compiled CLI, not a run from source (review H2).
 * A compiled CLI registers its embedded plugin table at startup
 * (`hasEmbeddedPlugins`). A source run registers none. A compiled binary
 * with an empty table also counts, by `Bun.isStandaloneExecutable`.
 */
export function isCompiledHost(): boolean {
  return hasEmbeddedPlugins() || isStandaloneExecutable()
}

/** The result of {@link extractHelper}. It never throws. */
export type ExtractResult = { ok: true; path: string } | { ok: false; error: string }

/** Injectable effects of {@link extractHelper}. */
export interface ExtractDeps {
  /** The environment, for `CUD_HELPER`. Default: `process.env`. */
  env?: Record<string, string | undefined>
  /** Gives a disk path for `rel` in the package. Default: core `execPath`. */
  execPath?: (packageDir: string, rel: string) => string
  /**
   * For a disk package with no helper: the extracted helper of the embedded
   * package of the same name, or undefined. Default: {@link embeddedHelperFor}.
   */
  embeddedFallback?: (packageDir: string) => string | undefined
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
 * The helper of the embedded package with the same name as the disk package
 * at `packageDir`, extracted to disk. Undefined when no table is registered,
 * when `packageDir` is embedded itself, or when the embedded package has no
 * helper. A write failure throws (core `materializeEmbedded`).
 *
 * @param packageDir - The plugin folder (`ctx.packageDir`).
 */
export function embeddedHelperFor(packageDir: string): string | undefined {
  if (!hasEmbeddedPlugins()) return undefined
  const own = pluginPackageFor(packageDir)
  if (own.kind === "embedded") return undefined
  const twin = embeddedPluginPackages().find((p) => p.name === own.name)
  if (twin === undefined || !twin.hasFile(HELPER_KEY)) return undefined
  return twin.execPath(HELPER_KEY)
}

/**
 * Make sure that the helper of an embedded package is on disk.
 *
 * Order:
 * 1. `env.CUD_HELPER` is set: do nothing. `helperBinary` uses that path.
 * 2. An earlier success for `packageDir` and its file still exists: use it,
 *    so later calls skip the byte compare of core.
 * 3. Call `execPath(packageDir, HELPER_KEY)`. When that file exists, use it.
 * 4. Else call `embeddedFallback(packageDir)` (a disk package in a compiled
 *    CLI). When it gives a path, use it.
 * 5. Else give the path of step 3. The handler then gives the missing-helper text.
 *
 * A throw in step 3 or 4 (for example a home folder that cannot be written)
 * gives `ok: false`.
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
  const fallback = deps.embeddedFallback ?? embeddedHelperFor
  try {
    const own = execPath(packageDir, HELPER_KEY)
    const path = exists(own) ? own : (fallback(packageDir) ?? own)
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
