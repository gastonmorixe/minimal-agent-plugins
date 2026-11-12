/**
 * How the CDP daemon (`bin/cdp-server.ts`) is started, the same way from a
 * source checkout and from a compiled minimal-agent binary.
 *
 * Both spawn sites (the `ChromeCDP` auto-spawn and `cdpd start`) use
 * {@link serverArgv}, which is core `selfSpawn().script("ma-chrome-cdp/cdp-server", ...)`:
 *
 * | | source run | compiled binary |
 * |---|---|---|
 * | argv | `[bun, <pkg>/bin/cdp-server.ts]` | `[<binary>, "__run", "ma-chrome-cdp/cdp-server"]` |
 *
 * No `bun` on PATH is assumed. The env goes through {@link daemonEnv} (core
 * `childEnv`), so `BUN_BE_BUN` never reaches the binary, which would then run
 * as the plain `bun` CLI instead of dispatching the daemon.
 *
 * @module lib/daemon-spawn
 */

import { join } from "node:path"

import {
  childEnv,
  type SelfSpawnOptions,
  selfSpawn,
} from "@minimal-agent/core/plugin-api/utils/self-spawn"

/** Embedded script id of the daemon (manifest `scripts["cdp-server"]`). */
export const SERVER_SCRIPT_ID = "ma-chrome-cdp/cdp-server"

/**
 * `pgrep -f` / `pkill -f` pattern (extended regex) that matches the daemon in
 * both run modes: `.../bin/cdp-server.ts` from source and
 * `<binary> __run ma-chrome-cdp/cdp-server` compiled. It does not match the
 * default log file `/tmp/cdp-server.log`.
 */
export const SERVER_PROCESS_PATTERN = "cdp-server\\.ts|__run ma-chrome-cdp/cdp-server"

/** Run-mode seam forwarded to core `selfSpawn` (tests). Default: this process. */
export type SpawnModeOptions = Pick<SelfSpawnOptions, "execPath" | "standalone">

/** Absolute path to `bin/cdp-server.ts` inside the plugin package. */
export function serverPathFor(packageDir: string): string {
  return join(packageDir, "bin", "cdp-server.ts")
}

/** The argv that starts the daemon. See the module doc. */
export function serverArgv(packageDir: string, opts: SpawnModeOptions = {}): string[] {
  return selfSpawn(opts).script(SERVER_SCRIPT_ID, serverPathFor(packageDir))
}

/** The daemon env: `base` (default `process.env`) without `BUN_BE_BUN`. */
export function daemonEnv(
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return childEnv(base)
}
