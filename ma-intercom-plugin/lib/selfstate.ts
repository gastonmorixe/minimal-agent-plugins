/**
 * The session's own mutable self-state (phase + activity + start time),
 * persisted in a tiny per-session file so the three contexts that touch it can
 * share it across process-internal boundaries:
 *
 *   - `turn.didStart` / `turn.didEnd` event handlers WRITE phase + activity.
 *   - `agent.willStop` handler WRITES the `gone` flag.
 *   - the heartbeat slot READS it to compose each presence beat.
 *
 * These run in the same process but are separate handler invocations with no
 * shared memory contract, so a small file is the simplest reliable channel
 * (and it survives the slot's in-flight/timeout lifecycle). Stored under the
 * intercom dir, not the inbox/presence dirs, so directory scans stay clean.
 *
 * @module lib/selfstate
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { intercomDir } from "./paths.ts"
import type { SelfPhase } from "./presence.ts"

/** Persisted self-state. */
export interface SelfStateFile {
  readonly phase: SelfPhase
  readonly activity: string | null
  readonly startedAt: string
  readonly gone?: boolean
}

/** The self-state subdirectory (`intercom/self`). */
export function selfDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(intercomDir(env), "self")
}

/** Path to this session's self-state file. */
export function selfStatePath(sid: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(selfDir(env), `${sid}.json`)
}

/** Default self-state for a session that hasn't written one yet. */
export function defaultSelfState(nowIso: string): SelfStateFile {
  return { phase: "active", activity: null, startedAt: nowIso }
}

/** Read this session's self-state, or a default anchored at `nowIso`. */
export function readSelfState(path: string, nowIso: string): SelfStateFile {
  if (!existsSync(path)) return defaultSelfState(nowIso)
  try {
    const o = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
    const phase: SelfPhase =
      o.phase === "idle" || o.phase === "busy" || o.phase === "active" ? o.phase : "active"
    return {
      phase,
      activity:
        typeof o.activity === "string" && o.activity.length > 0 ? o.activity.slice(0, 100) : null,
      startedAt: typeof o.startedAt === "string" && o.startedAt.length > 0 ? o.startedAt : nowIso,
      ...(o.gone === true ? { gone: true } : {}),
    }
  } catch {
    return defaultSelfState(nowIso)
  }
}

/** Atomically write self-state (temp + rename). Best-effort. */
export function writeSelfState(path: string, state: SelfStateFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(state)}\n`)
  renameSync(tmp, path)
}

/**
 * Merge a partial update into the existing self-state and persist it. Preserves
 * `startedAt`. Returns the new state. Best-effort; swallows IO errors.
 */
export function updateSelfState(
  path: string,
  patch: Partial<SelfStateFile>,
  nowIso: string,
): SelfStateFile {
  const prev = readSelfState(path, nowIso)
  const next: SelfStateFile = {
    phase: patch.phase ?? prev.phase,
    activity: patch.activity !== undefined ? patch.activity : prev.activity,
    startedAt: prev.startedAt,
    ...((patch.gone ?? prev.gone) ? { gone: true } : {}),
  }
  try {
    writeSelfState(path, next)
  } catch {
    // best-effort
  }
  return next
}
