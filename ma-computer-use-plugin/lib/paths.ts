/**
 * Shared filesystem locations for the computer-use daemon.
 *
 * The socket and logs live under the user's Application Support / Logs dirs so
 * they survive reboots and are per-user isolated (unlike /tmp). All are
 * overridable via env for tests and dev.
 *
 * @module lib/paths
 */

import { statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const HOME = homedir()

/** Directory holding the unix socket + pid file. */
export function supportDir(env: Record<string, string | undefined> = process.env): string {
  return env.CUD_DIR ?? join(HOME, "Library", "Application Support", "ma-computer-use")
}

/** Unix domain socket the Swift daemon listens on and the handler dials. */
export function socketPath(env: Record<string, string | undefined> = process.env): string {
  return env.CUD_SOCK ?? join(supportDir(env), "cud.sock")
}

/** Daemon log file (stdout+stderr of the helper binary). */
export function logPath(env: Record<string, string | undefined> = process.env): string {
  return env.CUD_LOG ?? join(HOME, "Library", "Logs", "ma-computer-use", "daemon.log")
}

/** Append-only JSONL audit log of every mutating action (written by the daemon). */
export function actionLogPath(env: Record<string, string | undefined> = process.env): string {
  return env.CUD_ACTION_LOG ?? join(HOME, "Library", "Logs", "ma-computer-use", "actions.log")
}

/** Kill-switch flag file: when present the daemon refuses mutating actions. */
export function disabledFlagPath(env: Record<string, string | undefined> = process.env): string {
  return env.CUD_DISABLED_FLAG ?? join(supportDir(env), "disabled")
}

/** True when `path` is a regular file (not a directory). */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Path of the helper executable that the control CLI and the handler start.
 *
 * Order:
 * 1. `env.CUD_HELPER`, when set.
 * 2. `<packageDir>/native/build/ComputerUseHelper`, the one Mach-O file that
 *    `cud build` makes with `swiftc`. Only a file counts, not a directory.
 * 3. The legacy `.app` executable,
 *    `<packageDir>/native/build/ComputerUseHelper.app/Contents/MacOS/ComputerUseHelper`.
 *
 * When none exists, it gives path 2, so the "not built" message names it.
 * The helper signature does not change the permission grants: macOS uses the
 * Accessibility and Screen Recording grants of the terminal app that starts it.
 *
 * @param packageDir - the plugin folder.
 * @param env - the environment, for `CUD_HELPER`.
 * @param exists - true when the path is a usable file. Tests inject it.
 */
export function helperBinary(
  packageDir: string,
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = isFile,
): string {
  if (env.CUD_HELPER) return env.CUD_HELPER
  const single = join(packageDir, "native", "build", "ComputerUseHelper")
  if (exists(single)) return single
  const legacy = join(helperApp(packageDir), "Contents", "MacOS", "ComputerUseHelper")
  if (exists(legacy)) return legacy
  return single
}

/** Path of the legacy .app bundle. Only the opt-in `cud notarize` makes it. */
export function helperApp(packageDir: string): string {
  return join(packageDir, "native", "build", "ComputerUseHelper.app")
}
