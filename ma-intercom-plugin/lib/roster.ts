/**
 * Build the peer roster: merge intercom's own presence feed with the
 * sub-agents plugin's presence feed, classify each into a liveness verdict,
 * and sort. Pure given the inputs (records + clock + probe), so the whole
 * roster is testable without disk.
 *
 * @module lib/roster
 */

import type { Thresholds } from "./config.ts"
import { classifyLiveness, LIVENESS_RANK, type Liveness, type LivenessProbe } from "./liveness.ts"
import type { PresenceRecord } from "./presence.ts"

/** One roster row: a peer plus its derived liveness. */
export interface RosterRow {
  readonly record: PresenceRecord
  readonly liveness: Liveness
  /** True for the row representing the calling session itself. */
  readonly isSelf: boolean
  /**
   * True when this peer lives on another computer (reached via the cloud
   * transport). Derived once here so renderers don't recompute it. Today every
   * record is local (`origin` absent), so this is always false until the cloud
   * bridge relays `origin:"remote"` records — at which point the `(Remote)`
   * marker + computerId column light up with no renderer change.
   */
  readonly isRemote: boolean
}

/**
 * Merge presence records from multiple sources, keeping the newest beat per
 * sid (so intercom's own richer record wins over the sub-agents one when both
 * exist and intercom is beating). Pure.
 */
export function mergePresence(...sources: readonly PresenceRecord[][]): PresenceRecord[] {
  const by = new Map<string, PresenceRecord>()
  for (const src of sources) {
    for (const rec of src) {
      const prev = by.get(rec.sid)
      if (!prev || rec.ts > prev.ts) by.set(rec.sid, rec)
    }
  }
  return [...by.values()]
}

/** Options for {@link buildRoster}. */
export interface BuildRosterOpts {
  readonly thresholds: Thresholds
  readonly probe: LivenessProbe
  /** The calling session's sid, so we can flag (and optionally hide) self. */
  readonly selfSid?: string
  /** Drop self from the roster. Default false (self shown, flagged). */
  readonly excludeSelf?: boolean
  /** Keep only reachable (online/stale) peers. Default false. */
  readonly liveOnly?: boolean
}

/**
 * Build a sorted roster from merged presence records. Sort order: reachable
 * first (by liveness rank), then most-recent beat. Self is flagged via
 * `isSelf` and sorted normally unless excluded.
 */
export function buildRoster(
  records: readonly PresenceRecord[],
  opts: BuildRosterOpts,
): RosterRow[] {
  const rows: RosterRow[] = []
  for (const rec of records) {
    const isSelf = opts.selfSid !== undefined && rec.sid === opts.selfSid
    if (isSelf && opts.excludeSelf) continue
    const liveness = classifyLiveness(rec, opts.thresholds, opts.probe)
    if (opts.liveOnly && liveness.status !== "online" && liveness.status !== "stale") continue
    const isRemote = rec.origin === "remote"
    rows.push({ record: rec, liveness, isSelf, isRemote })
  }
  rows.sort((a, b) => {
    const ra = LIVENESS_RANK[a.liveness.status]
    const rb = LIVENESS_RANK[b.liveness.status]
    if (ra !== rb) return ra - rb
    // newer beat first
    return a.record.ts < b.record.ts ? 1 : a.record.ts > b.record.ts ? -1 : 0
  })
  return rows
}

/** Count rows by a coarse online/busy/other split, for the footer line. */
export interface RosterCounts {
  readonly total: number
  readonly online: number
  readonly busy: number
  readonly idle: number
  readonly other: number
}

/** Tally roster rows for the ambient footer. Pure. Excludes self. */
export function rosterCounts(rows: readonly RosterRow[]): RosterCounts {
  const c = { total: 0, online: 0, busy: 0, idle: 0, other: 0 }
  for (const row of rows) {
    if (row.isSelf) continue
    c.total += 1
    const l = row.liveness
    if (l.status === "online") {
      if (l.phase === "busy") c.busy += 1
      else if (l.phase === "idle") c.idle += 1
      else c.online += 1
    } else if (l.status === "stale") {
      c.online += 1
    } else {
      c.other += 1
    }
  }
  return c
}
