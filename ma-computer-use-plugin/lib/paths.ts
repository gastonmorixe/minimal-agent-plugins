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

/** Daemon log file (stdout+stderr of the .app binary). */
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
 * Path to the signed .app's executable inside the plugin's native/build dir.
 * The control CLI execs this directly (preserves the bundle's signed identity
 * so TCC attributes grants to ComputerUseHelper.app, not bun).
 */
export function helperBinary(packageDir: string): string {
  return join(
    packageDir,
    "native",
    "build",
    "ComputerUseHelper.app",
    "Contents",
    "MacOS",
    "ComputerUseHelper",
  )
}

/** Path to the signed .app bundle. */
export function helperApp(packageDir: string): string {
  return join(packageDir, "native", "build", "ComputerUseHelper.app")
}
