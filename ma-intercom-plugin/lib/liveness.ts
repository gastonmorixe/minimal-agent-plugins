/**
 * Derived liveness — the correctness core of intercom's presence model.
 *
 * A session NEVER self-declares "I am alive" or "I am dead". It only publishes
 * a heartbeat: its pid and a timestamp, rewritten every few seconds. Readers
 * decide what that means by combining:
 *
 *   1. heartbeat freshness (now - record.ts), and
 *   2. a `kill(pid, 0)` liveness probe (same host only), and
 *   3. an optional best-effort `gone` marker (clean shutdown).
 *
 * This is why a session that dies UNCLEANLY (crash, SIGKILL, power loss, a
 * never-fired exit hook) is still correctly reported: it simply stops beating,
 * its age crosses the thresholds, and — if we can see its pid is gone — we call
 * it dead; if the pid is somehow still around but not beating, we call it hung.
 *
 * Pure given the injected `now` / `pidAlive` / `sameHost`, so every band is
 * unit-testable with a fake clock and a fake probe.
 *
 * @module lib/liveness
 */

import type { Thresholds } from "./config.ts"
import type { PresenceRecord, SelfPhase } from "./presence.ts"

/**
 * A liveness verdict. Discriminated union — make illegal states
 * unrepresentable, and force every renderer to handle each case.
 *
 * - `online` — beating recently (or stale but pid-confirmed alive). Carries the
 *   self-reported `phase` so the UI can say active/idle/busy.
 * - `stale`  — not beating on schedule, and we can't probe (cross-host). Maybe
 *   alive, maybe not. Honest "I'm not sure, last seen X".
 * - `hung`   — pid is alive but the process stopped beating well past the stale
 *   threshold. Wedged / suspended / stuck, not cleanly gone.
 * - `dead`   — pid is gone (probed), so the process is no longer running.
 * - `offline`— cleanly exited (`gone` marker), or last seen too long ago on a
 *   host we can't probe. Not running.
 */
export type Liveness =
  | {
      readonly status: "online"
      readonly phase: SelfPhase
      readonly pid: number
      readonly since: string
      readonly ageMs: number
    }
  | {
      readonly status: "stale"
      readonly pid: number
      readonly lastSeen: string
      readonly ageMs: number
    }
  | {
      readonly status: "hung"
      readonly pid: number
      readonly lastSeen: string
      readonly ageMs: number
    }
  | {
      readonly status: "dead"
      readonly reason: string
      readonly lastSeen: string
      readonly ageMs: number
    }
  | {
      readonly status: "offline"
      readonly reason: string
      readonly lastSeen: string
      readonly ageMs: number
    }

/** The injected collaborators a classification needs. */
export interface LivenessProbe {
  /** Wall clock in ms (injected for testability). */
  readonly now: number
  /** Is this pid alive on THIS machine? `undefined` when we shouldn't probe. */
  readonly pidAlive?: (pid: number) => boolean
  /** This reader's host name, to decide whether a pid probe is meaningful. */
  readonly host: string
}

/** A coarse ordering for sorting rosters: most-present first. */
export const LIVENESS_RANK: Record<Liveness["status"], number> = {
  online: 0,
  stale: 1,
  hung: 2,
  offline: 3,
  dead: 4,
}

/**
 * Classify one presence record into a {@link Liveness} verdict.
 *
 * Bands (see DESIGN.md §5). Same-host records get the pid probe; cross-host
 * records fall back to age-only because `kill(pid,0)` on a remote pid is
 * meaningless.
 */
export function classifyLiveness(
  rec: PresenceRecord,
  thresholds: Thresholds,
  probe: LivenessProbe,
): Liveness {
  const lastSeen = rec.ts
  const ageMs = probe.now - Date.parse(rec.ts)
  const ageValid = Number.isFinite(ageMs)
  const sameHost = rec.host.length > 0 && rec.host === probe.host
  const canProbe = sameHost && typeof probe.pidAlive === "function" && rec.pid > 0
  const alive = canProbe ? (probe.pidAlive as (pid: number) => boolean)(rec.pid) : undefined

  // Clean shutdown beats everything: the session told us it's leaving.
  if (rec.gone === true) {
    return { status: "offline", reason: "exited", lastSeen, ageMs: ageValid ? ageMs : 0 }
  }

  // Unparseable timestamp ⇒ treat as long-stale.
  if (!ageValid) {
    if (alive === false) {
      return { status: "dead", reason: "pid gone", lastSeen, ageMs: 0 }
    }
    return { status: "offline", reason: "no valid heartbeat", lastSeen, ageMs: 0 }
  }

  // Fresh band: trust the self-reported phase.
  if (ageMs <= thresholds.freshMs) {
    // Even fresh, if we can prove the pid is gone, it's dead (rare race).
    if (alive === false) {
      return { status: "dead", reason: "pid gone", lastSeen, ageMs }
    }
    return { status: "online", phase: rec.phase, pid: rec.pid, since: rec.startedAt, ageMs }
  }

  // Stale band: not beating on schedule.
  if (ageMs <= thresholds.staleMs) {
    if (alive === true) {
      // pid confirmed alive: a slow/blocked beat, still effectively online.
      return { status: "online", phase: rec.phase, pid: rec.pid, since: rec.startedAt, ageMs }
    }
    if (alive === false) {
      return { status: "dead", reason: "pid gone", lastSeen, ageMs }
    }
    // can't probe (cross-host): honest uncertainty.
    return { status: "stale", pid: rec.pid, lastSeen, ageMs }
  }

  // Past the stale threshold.
  if (alive === true) {
    return { status: "hung", pid: rec.pid, lastSeen, ageMs }
  }
  if (alive === false) {
    return { status: "dead", reason: "pid gone", lastSeen, ageMs }
  }
  // can't probe and long silent ⇒ presumed gone.
  return { status: "offline", reason: "last seen long ago", lastSeen, ageMs }
}

/** A short human label for a verdict (no ANSI). */
export function livenessLabel(l: Liveness): string {
  switch (l.status) {
    case "online":
      return l.phase === "busy" ? "busy" : l.phase === "idle" ? "idle" : "online"
    case "stale":
      return "stale"
    case "hung":
      return "hung"
    case "dead":
      return "dead"
    case "offline":
      return "offline"
    default: {
      const _exhaustive: never = l
      throw new Error(`unhandled liveness: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/** Is this verdict "the session is running right now"? Used by `liveOnly` filters + broadcast. */
export function isReachable(l: Liveness): boolean {
  return l.status === "online" || l.status === "stale"
}
