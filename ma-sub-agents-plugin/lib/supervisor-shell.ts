/**
 * Supervisor shell: the imperative wrapper that drives one {@link supervisorTick}.
 *
 * It gathers a probe per active worker (injected OS), runs the PURE tick,
 * persists the fleet when it changed, executes the resulting {@link Effect}s
 * (emit a bus event, inject a digest as a between-turns prompt, SIGTERM a
 * worker at a limit, kill a pid after the grace), and returns the live widget
 * string. All side-effects are injected so this is unit-testable without a
 * real process or bus; the heartbeat handler supplies the real implementations.
 *
 * @module sub-agents/lib/supervisor-shell
 */

import { drainUnreadMessages, mailboxPathFor } from "./mailbox.ts"
import { buildPresenceRows, writeLeadPresence } from "./presence.ts"
import { type ProbeDeps, probeWorker, streamPathFor } from "./spawn.ts"
import { type SubagentStore } from "./store.ts"
import { type Effect, supervisorTick, type WorkerProbe } from "./supervisor.ts"
import { isActive } from "./types.ts"
import { renderWidget } from "./widget.ts"

/** Default flush window (ms) before killing a pid that already wrote its result sentinel. */
export const SENTINEL_FLUSH_MS = 500

/**
 * Wrap a synchronous `kill` into a delayed stopper that gives a completed
 * worker a brief flush window without keeping the lead event loop alive.
 */
export function delayedKill(kill: (pid: number) => void): (pid: number, delayMs: number) => void {
  return (pid, delayMs) => {
    const timer = setTimeout(
      () => {
        try {
          kill(pid)
        } catch {
          // pid already gone
        }
      },
      Math.max(0, delayMs),
    )
    timer.unref?.()
  }
}

/** Injected collaborators for {@link runSupervisor}. */
export interface SupervisorDeps {
  readonly store: SubagentStore
  readonly probeDeps: ProbeDeps
  /** Emit on the plugin bus (the heartbeat passes `ctx.emit`). */
  readonly emit: (channel: string, payload?: unknown) => void
  /** Kill a pid (SIGKILL: the grace ended, or the worker already reported). */
  readonly kill: (pid: number) => void
  /**
   * Optional graceful/delayed stopper used only when `reason === "result sentinel written"`,
   * letting the finished worker flush before SIGKILL. Falls back to `kill` when omitted.
   */
  readonly stopAfterFlush?: (pid: number, delayMs: number) => void
  /** Flush delay (ms) passed to {@link stopAfterFlush}. Default {@link SENTINEL_FLUSH_MS}. */
  readonly sentinelFlushMs?: number
  /**
   * Send SIGTERM to a pid at a limit, so the worker can report before the
   * grace ends. Optional: without it, no SIGTERM goes out, and the SIGKILL at
   * the grace end still reaps the worker.
   */
  readonly terminate?: (pid: number) => void
  /** Where child `.result.json` sentinels live. */
  readonly sessionsDir: string
  readonly leadSid: string
  readonly now: () => Date
  /** Live-area tick. Kept for compatibility: the widget blink uses the clock. */
  readonly tick: number
  readonly ansi: boolean
  readonly tokenBudget?: number
  readonly maxRows?: number
  /** Terminal width for the widget. Default: `process.stdout.columns`, else 120. */
  readonly columns?: number
  /** Fade the running `●` in truecolor. Default: true when `COLORTERM` is truecolor. */
  readonly fade?: boolean
  /** When set, publish presence rows (lead + fleet) into this mesh directory. */
  readonly presenceDir?: string
  /** Lead process id, for the lead's presence row. */
  readonly leadPid?: number
  readonly leadModel?: string
  readonly leadCwd?: string
}

/**
 * Run one supervisor pass. Returns the widget string to paint, or `null` when
 * no worker is active (the live area collapses).
 */
export function runSupervisor(deps: SupervisorDeps): string | null {
  const records = deps.store.all()

  // Probe every active worker (skip terminal ones — nothing to observe).
  const probes = new Map<string, WorkerProbe>()
  for (const r of records) {
    if (!isActive(r.status)) continue
    if (r.status.kind === "running") {
      probes.set(
        r.id,
        probeWorker(
          {
            pid: r.status.pid,
            resultPath: `${deps.sessionsDir}/${r.sid}.result.json`,
            transcriptPath: `${deps.sessionsDir}/${r.sid}.jsonl`,
            logPath: `${deps.sessionsDir}/${r.sid}.log`,
            streamPath: streamPathFor(deps.sessionsDir, r.sid),
            ...(r.expectArtifacts && r.expectArtifacts.length > 0
              ? { expectArtifacts: r.expectArtifacts }
              : {}),
          },
          deps.probeDeps,
        ),
      )
    }
    // queued: no pid yet; the tick leaves it unless a probe says otherwise.
  }

  const now = deps.now()
  const out = supervisorTick({
    records,
    probes,
    now: now.toISOString(),
    nowMs: now.getTime(),
  })

  // Persist first, then run the effects. Known gap (accepted): if the lead
  // dies between the two, the stored `grace` marker has no SIGTERM behind it.
  // The next lead continues the grace and sends only the SIGKILL at its end
  // (at most DEFAULT_GRACE_SEC later), so the worker gets no wrap-up turn.
  if (out.changed) deps.store.replaceAll(out.records)
  for (const e of out.effects) runEffect(e, deps)

  // Surface urgent worker-to-lead mailbox messages (blocker / interrupt) so an
  // idle lead wakes up instead of waiting for the worker's deadline.
  try {
    const mailPath = mailboxPathFor(deps.sessionsDir, deps.leadSid)
    const urgent = drainUnreadMessages(mailPath, "lead").filter(
      (m) => m.kind === "blocker" || m.kind === "interrupt",
    )
    if (urgent.length > 0) {
      const lines = urgent.map((m, i) => `${i + 1}. [${m.from} ${m.kind}] ${m.body}`).join("\n")
      deps.emit("prompt.inject", {
        text: `Sub-agent mailbox alert:\n${lines}`,
        source: "subagents:mailbox",
      })
    }
  } catch {
    // best-effort
  }

  // Publish presence (the agent-mesh): the lead reports itself + its fleet.
  // Best-effort — a write failure must never break the supervisor.
  if (deps.presenceDir) {
    try {
      const rows = buildPresenceRows(
        {
          sid: deps.leadSid,
          pid: deps.leadPid ?? 0,
          ...(deps.leadModel ? { model: deps.leadModel } : {}),
          ...(deps.leadCwd ? { cwd: deps.leadCwd } : {}),
        },
        out.records,
        now.toISOString(),
      )
      writeLeadPresence(deps.presenceDir, deps.leadSid, rows)
    } catch {
      // ignore
    }
  }

  const columns = deps.columns ?? process.stdout.columns
  return renderWidget(out.records, {
    ...(columns ? { columns } : {}),
    fade: deps.fade ?? /truecolor|24bit/i.test(process.env.COLORTERM ?? ""),
    ansi: deps.ansi,
    tick: deps.tick,
    nowMs: now.getTime(),
    leadSid: deps.leadSid,
    ...(deps.tokenBudget !== undefined ? { tokenBudget: deps.tokenBudget } : {}),
    ...(deps.maxRows !== undefined ? { maxRows: deps.maxRows } : {}),
  })
}

/** Execute one effect via the injected side-effects. */
function runEffect(e: Effect, deps: SupervisorDeps): void {
  switch (e.type) {
    case "emit":
      deps.emit(e.channel, e.payload)
      break
    case "inject":
      // Report-back to the lead rides the existing prompt.inject port: it
      // lands BETWEEN turns and survives resume.
      deps.emit("prompt.inject", { text: e.text, source: e.source })
      break
    case "stop":
      try {
        if (e.reason === "result sentinel written" && deps.stopAfterFlush) {
          deps.stopAfterFlush(e.pid, deps.sentinelFlushMs ?? SENTINEL_FLUSH_MS)
        } else {
          deps.kill(e.pid)
        }
      } catch {
        // pid already gone — the next tick reaps it.
      }
      break
    case "signal":
      // The reducer emits this once per worker (the `grace` marker latches it).
      try {
        deps.terminate?.(e.pid)
      } catch {
        // pid already gone — the next tick reaps it.
      }
      break
    default: {
      throw new Error(`unhandled effect: ${String(e satisfies never)}`)
    }
  }
}
