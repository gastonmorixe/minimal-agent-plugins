/**
 * Imperative shell for the startup-profile file a worker boots with. Only the
 * write lives here, so `spawn-plan.ts` and `inherit-summary.ts` stay pure.
 *
 * @module sub-agents/lib/profile-io
 */

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import type { StartupProfile } from "./host-types.ts"

/** Path of a session's startup profile: `<sessionsDir>/<sid>.profile.json` (core layout). */
export function profilePathFor(sessionsDir: string, sid: string): string {
  return join(sessionsDir, `${sid}.profile.json`)
}

/**
 * Write `profile` as JSON to `path` (tmp file, chmod 0o600, then rename), the
 * same shape core writes for the lead. The chmod is explicit because
 * `writeFileSync`'s mode is ignored when the tmp file already exists. On an
 * IO error the tmp file is removed and the error is thrown.
 */
export function writeStartupProfile(path: string, profile: StartupProfile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}
