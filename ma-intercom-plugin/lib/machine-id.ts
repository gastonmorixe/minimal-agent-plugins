/**
 * Stable per-install machine id — the `computerId` that identifies WHICH
 * computer a peer (or team) lives on, for the `(Remote)` marker and the global
 * `(computerId, sid)` address.
 *
 * ## Why not hostname (Steve's ruling 1)
 *
 * `hostname()` is neither unique nor stable: two laptops are both
 * "MacBook-Pro.local", and a rename changes it. So we mint a uuid ONCE and
 * persist it under the agent home (`~/.minimal-agent/machine-id`), reusing it on
 * every read. That file is per-install, survives restarts, and is the same value
 * the cloud backend can key a device on later.
 *
 * Pure-ish: a thin read-or-create over the agent home, with the home resolved
 * exactly like the rest of intercom (`MINIMAL_AGENT_HOME` env, host-published).
 * Best-effort: if the disk read/write fails (read-only fs, race), we fall back to
 * an in-memory ephemeral id for this process rather than throwing — a missing
 * computerId must never break presence or messaging.
 *
 * @module lib/machine-id
 */

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { homeDir } from "./paths.ts"

/** Absolute path to the persisted machine-id file. */
export function machineIdPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), "machine-id")
}

/** Accept only a sane id shape (uuid-ish / hex+dashes), so a corrupt file is ignored. */
const SAFE_MACHINE_ID = /^[A-Za-z0-9-]{8,128}$/

/** Process-lifetime cache so we touch disk at most once per run. */
let cached: string | null = null

/**
 * Read the stable machine id, creating + persisting one on first use.
 *
 * Resolution order:
 *   1. process cache (set on first call this run),
 *   2. the persisted `~/.minimal-agent/machine-id` file (if present + valid),
 *   3. mint a new uuid, persist it atomically (temp + rename), return it.
 *
 * On any IO failure we return a fresh ephemeral uuid (cached for this process)
 * so callers always get SOME stable-within-run id. `now`/`makeId` injected for
 * tests.
 */
export function machineId(
  env: NodeJS.ProcessEnv = process.env,
  makeId: () => string = randomUUID,
): string {
  if (cached) return cached
  const path = machineIdPath(env)

  // 2. Existing valid file wins.
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8").trim()
      if (SAFE_MACHINE_ID.test(raw)) {
        cached = raw
        return raw
      }
    }
  } catch {
    // fall through to create
  }

  // 3. Mint + persist atomically.
  const id = makeId()
  try {
    mkdirSync(homeDir(env), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${id}\n`)
    renameSync(tmp, path)
  } catch {
    // best-effort: an unpersisted id is still stable for THIS process.
  }
  cached = id
  return id
}

/** Test-only: clear the process cache so a test can re-derive from disk/env. */
export function __resetMachineIdCacheForTests(): void {
  cached = null
}
