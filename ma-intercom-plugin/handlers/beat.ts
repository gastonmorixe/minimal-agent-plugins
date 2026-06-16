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
import { readInbox } from "../lib/inbox.ts"
import { cursorPath, inboxPath, presenceDir, presencePath, sessionLogPath } from "../lib/paths.ts"
import { phaseFromMtime, readPresenceDir, writePresence } from "../lib/presence.ts"
import { renderArrival } from "../lib/render.ts"
import { readSelfState, selfStatePath } from "../lib/selfstate.ts"
import { realPidAlive } from "../lib/service.ts"

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
  const self = selfIdentity(ctx.agent)
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
    publish: (rec) => writePresence(presencePath(self.sid, env), rec),
    // Footer counts intercom peers only (own feed), not the sub-agents graveyard.
    readAllPresence: () => readPresenceDir(presenceDir(env)),
    readMyInbox: () => readInbox(inboxPath(self.sid, env)),
    readMyCursor: () => readCursor(cursorPath(self.sid, env)),
    // Merge-on-write (Math.max per field) so the heartbeat's `woken` advance
    // never clobbers a concurrent `seen`/`read` advance from the attachment or
    // the Inbox tool in this same process.
    writeMyCursor: (c) => advanceCursor(cursorPath(self.sid, env), c),
    emit: (channel, payload) => ctx.emit?.(channel, payload),
  }

  const result = runBeat(deps)

  // TUI notification: print newly arrived messages to the terminal so the user
  // sees them even when the agent is mid-turn or idle. Written to stderr so it
  // doesn't pollute the agent's stdout/transcript pipeline.
  if (result.fresh.length > 0) {
    try {
      ctx.stderr.write("\n" + renderArrival(result.fresh) + "\n")
    } catch {
      // best-effort
    }
  }

  return result.footer
}
