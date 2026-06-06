/**
 * Filesystem paths for background-job state, colocated with session history.
 *
 * Everything lives under the session directory so it travels with the
 * transcript and survives resume:
 *
 *   <sessions>/<sid>.bgjobs.jsonl          the durable index (harness-owned)
 *   <sessions>/<sid>.bgjobs/<jobId>.log    full raw combined output (runner-owned)
 *   <sessions>/<sid>.bgjobs/<jobId>.status.json  runner state sidecar
 *
 * Mirrors minimal-agent's own layout (`<sid>.jsonl`, `<sid>.blobs/`,
 * `<sid>.subagents.jsonl`). Pure path math, no IO.
 *
 * @module lib/paths
 */

import { homedir } from "node:os"
import { join } from "node:path"

/** Default sessions directory, honoring `MINIMAL_AGENT_HOME` if set. */
export function defaultSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.MINIMAL_AGENT_HOME?.trim() || join(homedir(), ".minimal-agent")
  return join(base, "sessions")
}

/** Absolute path to the per-session index file (`<sid>.bgjobs.jsonl`). */
export function indexPath(sessionsDir: string, sid: string): string {
  return join(sessionsDir, `${sid}.bgjobs.jsonl`)
}

/** Absolute path to the per-session job directory (`<sid>.bgjobs/`). */
export function jobsDir(sessionsDir: string, sid: string): string {
  return join(sessionsDir, `${sid}.bgjobs`)
}

/** Absolute path to one job's raw log file. */
export function logPath(sessionsDir: string, sid: string, id: string): string {
  return join(jobsDir(sessionsDir, sid), `${id}.log`)
}

/** Absolute path to one job's status sidecar. */
export function statusPath(sessionsDir: string, sid: string, id: string): string {
  return join(jobsDir(sessionsDir, sid), `${id}.status.json`)
}
