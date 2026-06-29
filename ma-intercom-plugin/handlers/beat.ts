/**
 * The intercom heartbeat — a live-area footer slot that ticks every few
 * seconds. It publishes this session's presence, wakes the REPL when a
 * ping/interrupt arrives (via `prompt.inject`), and paints the ambient
 * `⇆ intercom · N online` footer.
 *
 * Thin imperative shell: supplies real fs/clock/emit to the pure `runBeat`
 * core. The slot lifecycle (in-flight guard, timeout, abort on REPL close) is
 * owned by the host's live-area scheduler.
 *
 * @module handlers/beat
 */

import { statSync } from "node:fs"

import { type BeatDeps, runBeat } from "../lib/beat.ts"
import { presenceDisabled, resolveThresholds } from "../lib/config.ts"
import { advanceCursor, readCursor } from "../lib/cursors.ts"
import { runGc } from "../lib/gc.ts"
import type { LiveAreaHandlerContext } from "../lib/host-types.ts"
import { selfIdentity, thisHost } from "../lib/identity.ts"
import { cursorPath, sessionLogPath } from "../lib/paths.ts"
import { phaseFromMtime } from "../lib/presence.ts"
import { toArrivalNotice } from "../lib/render.ts"
import { readSelfState, selfStatePath } from "../lib/selfstate.ts"
import { makeLocalFsTransport, realPidAlive } from "../lib/service.ts"

/** Read a file's mtime in ms, or null when it doesn't exist / can't stat. */
function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** Live-area heartbeat slot handler. */
export default async function beat(ctx: LiveAreaHandlerContext): Promise<string | null> {
  if (presenceDisabled(ctx.env)) return null
  const self = selfIdentity(ctx.agent, ctx.env)
  if (!self) return null

  const env = ctx.env
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const state = readSelfState(selfStatePath(self.sid, env), nowIso)
  const thresholds = resolveThresholds(env)
  const host = thisHost()

  // Garbage-collect the store on startup (tick 0) and roughly once a minute
  // after, so the presence dir doesn't accumulate dead sessions (the graveyard
  // that otherwise inflates the roster, e.g. "606 peers"). Best-effort; runGc
  // never throws. GC_EVERY_TICKS * heartbeatMs ≈ 60s at the default 5s cadence.
  const GC_EVERY_TICKS = 12
  if (ctx.tick === 0 || ctx.tick % GC_EVERY_TICKS === 0) {
    runGc({ env, now: nowMs, thresholds, pidAlive: realPidAlive, host })
  }

  // Derive busy/idle from how recently OUR OWN transcript was written. A turn
  // streams into the JSONL, so a fresh mtime ⇒ busy. Window = a few heartbeats
  // so a lull between tool calls doesn't flip us to idle. This is robust across
  // resume and needs no turn-lifecycle events (which the host doesn't emit yet).
  const phase = phaseFromMtime(
    mtimeMs(sessionLogPath(self.sid, env)),
    nowMs,
    thresholds.heartbeatMs * 2,
  )

  // Presence publish + roster read + inbox read all go through the Transport
  // port (Ports & Adapters). The live-area context carries no `ctx.host`, so
  // there's no transport registry here today: this is the local fs adapter,
  // byte-identical to the prior direct fs calls. When the cloud bridge lands it
  // relays remote presence into the same dirs, so this read picks them up
  // unchanged (and the footer counts them).
  const transport = makeLocalFsTransport(env, self.sid)
  const deps: BeatDeps = {
    self,
    state: {
      phase,
      activity: state.activity,
      cwd: ctx.cwd,
      projectRoot: ctx.cwd,
    },
    startedAt: state.startedAt,
    nowMs,
    thresholds,
    probe: { now: nowMs, pidAlive: realPidAlive, host },
    publish: (rec) => transport.publishPresence(rec),
    // Footer counts intercom peers only (own feed), not the sub-agents graveyard.
    readAllPresence: () => transport.readPresence(),
    readMyInbox: () => transport.readInbox(self.sid),
    readMyCursor: () => readCursor(cursorPath(self.sid, env)),
    // Merge-on-write (Math.max per field) so the heartbeat's `woken` advance
    // never clobbers a concurrent `seen`/`read` advance from the attachment or
    // the Inbox tool in this same process.
    writeMyCursor: (c) => advanceCursor(cursorPath(self.sid, env), c),
    emit: (channel, payload) => ctx.emit?.(channel, payload),
  }

  const result = runBeat(deps)

  // TUI notification: surface newly arrived messages so the user sees them even
  // when the agent is mid-turn or idle. We no longer hand-draw a box to stderr
  // (that bypassed the host's framing, html-escaped the body, and was never
  // persisted). Instead we emit a structured notice on the shared bus and let
  // the HOST own framing, escaping, routing, and persistence to the session log.
  // This shell decides WHEN to notify; `toArrivalNotice` owns WHAT the notice
  // looks like (icon/title/color/rows/text), so presentation stays out of here.
  if (result.fresh.length > 0) {
    try {
      ctx.emit?.("notification.emit", toArrivalNotice(result.fresh))
    } catch {
      // best-effort
    }
  }

  return result.footer
}
