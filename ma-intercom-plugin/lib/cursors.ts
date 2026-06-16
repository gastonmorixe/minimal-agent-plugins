/**
 * Recipient-owned cursors: per-session high-water marks into my own inbox.
 * Pure shape + a thin atomic read/write shell. Only the inbox owner touches
 * its cursor, so there's never write contention.
 *
 * Three independent marks, all counted in ENVELOPES (not bytes), so they stay
 * valid even if a torn line is later completed:
 *
 *   - `seen`  — lines already rendered to the model by the turn attachment.
 *   - `woken` — lines the heartbeat already injected a wake nudge for.
 *   - `read`  — lines the `Inbox` tool last reported (manual marker).
 *
 * Separating them lets passive content delivery (`seen`), active wake
 * (`woken`), and manual review (`read`) advance independently without one
 * starving another.
 *
 * @module lib/cursors
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** Per-recipient cursor state. */
export interface Cursor {
  readonly seen: number
  readonly woken: number
  readonly read: number
}

/** The zero cursor (a fresh inbox, nothing consumed). */
export const ZERO_CURSOR: Cursor = { seen: 0, woken: 0, read: 0 }

/** Coerce an unknown parsed object into a {@link Cursor}, clamping to ≥0 ints. */
export function coerceCursor(o: unknown): Cursor {
  if (o === null || typeof o !== "object") return ZERO_CURSOR
  const r = o as Record<string, unknown>
  const n = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  return { seen: n(r.seen), woken: n(r.woken), read: n(r.read) }
}

/** Read a cursor file by path, defaulting to {@link ZERO_CURSOR}. */
export function readCursor(path: string): Cursor {
  if (!existsSync(path)) return ZERO_CURSOR
  try {
    return coerceCursor(JSON.parse(readFileSync(path, "utf-8")))
  } catch {
    return ZERO_CURSOR
  }
}

/** Atomically write a cursor file (temp + rename). Best-effort. */
export function writeCursor(path: string, cursor: Cursor): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(cursor)}\n`)
  renameSync(tmp, path)
}

/**
 * Advance a cursor by merging the given marks with what's already on disk,
 * taking the MAX of each field, then writing atomically.
 *
 * Cursors are high-water marks that only move forward. Three actors in one
 * process touch the same file (the inbox attachment advances `seen`, the
 * heartbeat advances `woken`, the Inbox tool advances `read`). A naive
 * read-modify-write by one can clobber a sibling's just-written advance if an
 * await interleaves. Merging with `Math.max` against the current on-disk value
 * makes every advance monotonic and conflict-free: a stale writer can only
 * re-assert an older-or-equal value, never roll a sibling back. Best-effort.
 */
export function advanceCursor(path: string, marks: Partial<Cursor>): Cursor {
  const cur = readCursor(path)
  const next: Cursor = {
    seen: Math.max(cur.seen, marks.seen ?? 0),
    woken: Math.max(cur.woken, marks.woken ?? 0),
    read: Math.max(cur.read, marks.read ?? 0),
  }
  try {
    writeCursor(path, next)
  } catch {
    // best-effort
  }
  return next
}
