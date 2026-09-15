/**
 * The resumable upload cursor: how far into a session's local JSONL we've
 * successfully shipped to the cloud.
 *
 * One file per session at `~/.minimal-agent/cloud-upload/<sid>.json` holding the
 * last `acceptedThroughClientLine` the backend acked. On the next flush we read
 * only lines AFTER it. Because the backend dedupes by `(sid, clientLine)`
 * (Mike's C1), re-sending an overlapping range after a crash is safe — the cursor
 * is an optimization, not a correctness requirement, but it keeps us from
 * re-uploading the whole transcript every turn.
 *
 * `clientLine` is the 0-based index of a record in the JSONL (line N). A cursor
 * of `-1` means "nothing shipped yet" (start from line 0).
 *
 * @module lib/upload-cursor
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Resolve the agent home like the rest of minimal-agent (host-published env). */
function homeDir(env: NodeJS.ProcessEnv): string {
  return env.MINIMAL_AGENT_HOME?.trim() || join(homedir(), ".minimal-agent")
}

/** The directory holding per-session upload cursors. */
export function uploadDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), "cloud-upload")
}

/** Path-traversal guard: a sid becomes a filename component. */
const SAFE_SID = /^[A-Za-z0-9_-]{1,128}$/
function safeSid(sid: string): boolean {
  return SAFE_SID.test(sid)
}

/** Absolute path to one session's upload cursor file. */
export function cursorPath(sid: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(uploadDir(env), `${sid}.json`)
}

/** Persisted cursor shape. */
export interface UploadCursor {
  readonly v: 1
  readonly sid: string
  /** 0-based index of the last record the backend acked (-1 = nothing yet). */
  readonly acceptedThroughClientLine: number
  /** Last server headSeq seen, for diagnostics. */
  readonly headSeq?: number
  /** ISO timestamp of the last successful flush. */
  readonly updatedAt: string
}

/** The "nothing shipped" cursor. */
export function zeroCursor(sid: string): UploadCursor {
  return { v: 1, sid, acceptedThroughClientLine: -1, updatedAt: new Date(0).toISOString() }
}

/** Read a session's cursor, or the zero cursor when absent/corrupt. */
export function readCursor(sid: string, env: NodeJS.ProcessEnv = process.env): UploadCursor {
  if (!safeSid(sid)) return zeroCursor(sid)
  const path = cursorPath(sid, env)
  if (!existsSync(path)) return zeroCursor(sid)
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<UploadCursor>
    if (
      raw.v === 1 &&
      typeof raw.acceptedThroughClientLine === "number" &&
      Number.isInteger(raw.acceptedThroughClientLine)
    ) {
      return {
        v: 1,
        sid,
        acceptedThroughClientLine: raw.acceptedThroughClientLine,
        ...(typeof raw.headSeq === "number" ? { headSeq: raw.headSeq } : {}),
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      }
    }
    return zeroCursor(sid)
  } catch {
    return zeroCursor(sid)
  }
}

/** Atomically persist a session's cursor (temp + rename). Best-effort. */
export function writeCursor(cursor: UploadCursor, env: NodeJS.ProcessEnv = process.env): void {
  if (!safeSid(cursor.sid)) return
  const path = cursorPath(cursor.sid, env)
  try {
    mkdirSync(uploadDir(env), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(cursor)}\n`)
    renameSync(tmp, path)
  } catch {
    // best-effort: a missed cursor write just means we re-send next flush (the
    // backend dedupes, so it's safe).
  }
}

/**
 * Advance the cursor to a new acked line, monotonically (never moves backward).
 * Returns the persisted cursor.
 */
export function advanceCursor(
  sid: string,
  acceptedThroughClientLine: number,
  headSeq: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): UploadCursor {
  const cur = readCursor(sid, env)
  const next: UploadCursor = {
    v: 1,
    sid,
    acceptedThroughClientLine: Math.max(cur.acceptedThroughClientLine, acceptedThroughClientLine),
    ...(headSeq !== undefined
      ? { headSeq }
      : cur.headSeq !== undefined
        ? { headSeq: cur.headSeq }
        : {}),
    updatedAt: new Date().toISOString(),
  }
  writeCursor(next, env)
  return next
}
