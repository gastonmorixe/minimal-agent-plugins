/**
 * Shared filesystem locations for the computer-use daemon.
 *
 * The socket and logs live under the user's Application Support / Logs dirs so
 * they survive reboots and are per-user isolated (unlike /tmp). All are
 * overridable via env for tests and dev.
 *
 * @module lib/paths
 */

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

/**
 * Spawn lock file: `<socket>.spawn.lock`. For the default socket it is in the
 * support dir. Only one caller at a time stops or starts a helper (review H1).
 */
export function spawnLockPath(env: Record<string, string | undefined> = process.env): string {
  return `${socketPath(env)}.spawn.lock`
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

/**
 * Path of the helper executable that the control CLI and the handler start.
 *
 * Order:
 * 1. `env.CUD_HELPER`, when set.
 * 2. `<packageDir>/native/build/ComputerUseHelper`, the one Mach-O file that
 *    `cud build` makes with `swiftc`. In a compiled CLI, it is also the copy
 *    that `extractHelper` (lib/embedded-helper.ts) writes from the embedded
 *    table.
 *
 * When path 2 does not exist, it still gives path 2, so the "not built"
 * message names it.
 * The legacy `.app` executable is NOT a fallback (review H3): a `.app` from
 * the old Xcode build has no `protocol` in its ping, so the handshake stops
 * it on each call and it can never serve this plugin.
 * The helper signature does not change the permission grants: macOS uses the
 * Accessibility and Screen Recording grants of the terminal app that starts it.
 *
 * @param packageDir - the plugin folder.
 * @param env - the environment, for `CUD_HELPER`.
 */
export function helperBinary(
  packageDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.CUD_HELPER) return env.CUD_HELPER
  return join(packageDir, "native", "build", "ComputerUseHelper")
}

/**
 * Path of the legacy .app bundle. Only the opt-in `cud notarize` makes it and
 * signs it. The handler and `cud start` never run it.
 */
export function helperApp(packageDir: string): string {
  return join(packageDir, "native", "build", "ComputerUseHelper.app")
}
