/**
 * Idle-gap tracking for task durations.
 *
 * Problem: a task in `doing` keeps its clock running while the agent sits
 * idle. If the user stops at night and continues the next day, the task
 * shows "20h" for a few minutes of work. The same error reaches the footer
 * total (earliest start to latest end).
 *
 * Fix: record the time between a turn end and the next turn start. When
 * that pause is long (at least {@link IDLE_THRESHOLD_MS}), store it as an idle
 * gap in the tasks meta record. All duration math then subtracts the
 * overlap with those gaps.
 *
 * Everything here is pure. Epoch milliseconds only.
 *
 * @module tasks/lib/idle
 */

import type { TasksMeta } from "./parse.ts"

/** A pause shorter than this still counts as work time (user reading, thinking). */
export const IDLE_THRESHOLD_MS = 30 * 60_000

/** Max stored gaps per session. The oldest gaps drop first. */
export const MAX_IDLE_GAPS = 500

/** One idle window: `[startMs, endMs]`, epoch milliseconds. */
export type IdleGap = readonly [number, number]

/** Length of the overlap between `[aStart, aEnd]` and `[bStart, bEnd]`. */
export function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const lo = Math.max(aStart, bStart)
  const hi = Math.min(aEnd, bEnd)
  return hi > lo ? hi - lo : 0
}

/**
 * Milliseconds in `[start, end]` that are NOT inside an idle gap.
 * Returns `0` when `end <= start`.
 */
export function subtractGaps(start: number, end: number, gaps: readonly IdleGap[]): number {
  if (!(end > start)) return 0
  let total = end - start
  for (const [gs, ge] of gaps) total -= overlapMs(start, end, gs, ge)
  return total > 0 ? total : 0
}

/** Record that the agent went idle at `nowMs` (a turn just ended). */
export function markIdleStart(meta: TasksMeta, nowMs: number): TasksMeta {
  return { ...meta, idle_since: nowMs }
}

/**
 * Record that work resumed at `nowMs` (a turn is starting). A pause of at
 * least {@link IDLE_THRESHOLD_MS} becomes a stored gap. A shorter pause is
 * dropped. Returns `meta` unchanged when no idle period was open.
 */
export function markIdleEnd(meta: TasksMeta, nowMs: number): TasksMeta {
  const since = meta.idle_since
  if (since === null) return meta
  const long = nowMs - since >= IDLE_THRESHOLD_MS
  const gaps = long ? [...meta.idle_gaps, [since, nowMs] as [number, number]] : meta.idle_gaps
  return {
    ...meta,
    idle_since: null,
    idle_gaps: gaps.length > MAX_IDLE_GAPS ? gaps.slice(gaps.length - MAX_IDLE_GAPS) : gaps,
  }
}

/**
 * All gaps that apply at `nowMs`: the stored ones plus the open one
 * (turn ended, still idle) when it is already long enough.
 */
export function effectiveGaps(meta: TasksMeta, nowMs: number): IdleGap[] {
  const gaps: IdleGap[] = [...meta.idle_gaps]
  if (meta.idle_since !== null && nowMs - meta.idle_since >= IDLE_THRESHOLD_MS) {
    gaps.push([meta.idle_since, nowMs])
  }
  return gaps
}
