/**
 * One heartbeat tick, parameterized over its IO so it's directly testable with
 * a fake clock, an in-memory presence store, and a capturing emit.
 *
 * A tick does three things:
 *   1. Publishes THIS session's presence record (the liveness signal peers
 *      derive aliveness from).
 *   2. Drains the wake channel: new `ping`/`interrupt` messages past the
 *      `woken` cursor trigger ONE `prompt.inject` nudge so an idle REPL wakes
 *      between turns and renders the inbox attachment. `note` messages never
 *      wake (they wait for the user's next turn).
 *   3. Returns the ambient footer line (counts), or null when alone.
 *
 * The heartbeat handler is a thin wrapper that supplies real fs/clock/emit.
 *
 * @module lib/beat
 */

import type { Thresholds } from "./config.ts"
import type { Cursor } from "./cursors.ts"
import type { Envelope } from "./envelope.ts"
import type { SelfIdentity } from "./identity.ts"
import type { Liveness, LivenessProbe } from "./liveness.ts"
import { classifyLiveness } from "./liveness.ts"
import type { PresenceRecord, SelfPhase } from "./presence.ts"
import { renderFooter } from "./render.ts"
import { buildRoster, mergePresence, type RosterCounts, rosterCounts } from "./roster.ts"
import { sanitizePeerLine } from "./sanitize.ts"

/** The mutable bits a session reports about itself each beat. */
export interface SelfState {
  readonly phase: SelfPhase
  readonly activity: string | null
  readonly cwd: string
  readonly projectRoot: string
  /** Set true on the final (shutdown) beat. */
  readonly gone?: boolean
  /**
   * Team ids this session currently belongs to. Optional + absent-means-none:
   * omit (or pass `[]`) and the presence record carries no `teams` key, staying
   * byte-identical to pre-Teams Intercom.
   */
  readonly teams?: readonly string[]
}

/** Build this session's presence record from identity + current self-state. */
export function buildSelfPresenceRecord(
  self: SelfIdentity,
  state: SelfState,
  startedAt: string,
  nowIso: string,
): PresenceRecord {
  return {
    v: 1,
    sid: self.sid,
    short: self.short,
    pid: self.pid,
    host: self.host,
    ts: nowIso,
    startedAt,
    agentVersion: self.agentVersion,
    model: self.model,
    cwd: state.cwd,
    projectRoot: state.projectRoot,
    phase: state.phase,
    activity: state.activity,
    // The opt-in name rides every beat when set; absent ⇒ omitted (unnamed).
    ...(self.name ? { name: self.name } : {}),
    ...(state.gone ? { gone: true as const } : {}),
    // computerId is always known for a live self-record (identity mints it); a
    // teamless session omits `teams` so its on-disk shape is unchanged.
    ...(self.computerId ? { computerId: self.computerId } : {}),
    ...(state.teams && state.teams.length > 0 ? { teams: [...state.teams] } : {}),
  }
}

/** Inputs to {@link runBeat}. */
export interface BeatDeps {
  readonly self: SelfIdentity
  readonly state: SelfState
  readonly startedAt: string
  readonly nowMs: number
  readonly thresholds: Thresholds
  readonly probe: LivenessProbe
  /** Publish this session's presence record (atomic write). */
  readonly publish: (rec: PresenceRecord) => void
  /** Read all presence records (own feed + adapted sub-agents feed, merged by caller). */
  readonly readAllPresence: () => PresenceRecord[]
  /** Read my inbox envelopes. */
  readonly readMyInbox: () => Envelope[]
  /** Read my cursor. */
  readonly readMyCursor: () => Cursor
  /** Persist my cursor after advancing `woken`. */
  readonly writeMyCursor: (c: Cursor) => void
  /** Fire-and-forget prompt injection (the wake channel). */
  readonly emit: (channel: string, payload: unknown) => void
}

/** Result of a beat: the footer line (or null) plus a debug summary. */
export interface BeatResult {
  readonly footer: string | null
  readonly counts: RosterCounts
  readonly woke: number
  /** Fresh messages that triggered a wake (for TUI notification). Empty when no new messages. */
  readonly fresh: readonly Envelope[]
}

/** A short, human nudge injected when messages arrive while idle. */
export function wakeMessage(fresh: readonly Envelope[]): string {
  const interrupts = fresh.filter((e) => e.kind === "interrupt")
  const froms = [...new Set(fresh.map((e) => e.from.short))]
  const parts: string[] = [`${fresh.length} message(s)`]
  if (interrupts.length > 0) parts.push(`${interrupts.length} interrupt(s)`)
  const lead = `intercom: ${parts.join(", ")} from ${froms.join(", ")}`
  // First message body, clipped + sanitized, as a hint. The body is
  // peer-controlled and this string becomes a `prompt.inject` user turn, so it
  // must not be able to forge `<ma::...>` framing.
  const first = fresh[fresh.length - 1]
  const hint = first ? ` Latest: "${sanitizePeerLine(first.body).slice(0, 140)}"` : ""
  return `${lead}.${hint} The full message(s) are in the intercom-inbox attachment on this turn. Reply with Send if you need to.`
}

/**
 * Run one heartbeat tick. Publishes presence, drains the wake channel, returns
 * the footer. Pure given the injected IO.
 */
export function runBeat(deps: BeatDeps): BeatResult {
  const nowIso = new Date(deps.nowMs).toISOString()

  // 1. Publish my presence (best-effort; never throw out of a beat).
  const rec = buildSelfPresenceRecord(deps.self, deps.state, deps.startedAt, nowIso)
  try {
    deps.publish(rec)
  } catch {
    // ignore — a failed presence write must not break the REPL
  }

  // 2. Drain the wake channel (all message kinds wake the peer).
  let woke = 0
  let fresh: readonly Envelope[] = []
  try {
    const inbox = deps.readMyInbox()
    const cursor = deps.readMyCursor()
    fresh = inbox.slice(Math.min(cursor.woken, inbox.length))
    // All fresh messages wake — there is no passive "note" kind.
    if (fresh.length > 0) {
      // `emit` is best-effort and may be a no-op when the host wired no bus. If
      // it throws, we DON'T advance `woken`, so the next beat retries the wake.
      try {
        deps.emit("prompt.inject", { text: wakeMessage(fresh), source: "intercom" })
        woke = fresh.length
      } catch {
        // emit failed — hold the cursor so it retries next tick
      }
    }
    // Advance `woken` only as far as we've actually handled. When the wake emit
    // failed, woke stays 0 and the cursor stays put for the next beat.
    if (fresh.length > 0 && woke > 0) {
      deps.writeMyCursor({ ...cursor, woken: inbox.length })
    }
  } catch {
    // ignore — wake is best-effort
  }

  // 3. Footer.
  const records = deps.readAllPresence()
  const rows = buildRoster(records, {
    thresholds: deps.thresholds,
    probe: deps.probe,
    selfSid: deps.self.sid,
  })
  const counts = rosterCounts(rows)
  return { footer: renderFooter(counts), counts, woke, fresh: fresh ?? [] }
}

export type { Liveness }
/** Re-export so the handler can merge feeds without another import. */
export { classifyLiveness, mergePresence }
