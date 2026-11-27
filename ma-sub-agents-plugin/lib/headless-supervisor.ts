/**
 * Host-neutral fallback supervisor timer for leads without an active TUI
 * `liveAreaSlots` heartbeat (headless `-p` runs, SDK hosts, and Web hosts).
 *
 * In an interactive TUI, `handlers/heartbeat.ts` calls {@link noteHeartbeatTick}
 * every second, so this timer stays dormant (zero double-ticking). When no TUI
 * heartbeat ticked recently and the store has at least one active worker, this
 * timer advances {@link runSupervisor} so budgets, stall watchdogs, task sync,
 * blocker wakeups, and completion digests work identically on every host.
 *
 * @module sub-agents/lib/headless-supervisor
 */

import { supervisorDepsFromCtx } from "./handler-deps.ts"
import type { HookHandlerContext, LiveAreaHandlerContext } from "./host-types.ts"
import { ENV_RESULT_PATH } from "./spawn.ts"
import { ENV_LEAD } from "./spawn-plan.ts"
import { runSupervisor } from "./supervisor-shell.ts"
import { isActive } from "./types.ts"

const POLL_MS = 1500
const HEARTBEAT_SILENCE_MS = 2500

const lastHeartbeatAt = new Map<string, number>()
const activeTimers = new Map<string, ReturnType<typeof setInterval>>()

/** Record a TUI heartbeat tick for `leadSid` so the headless fallback yields to it. */
export function noteHeartbeatTick(leadSid: string, nowMs = Date.now()): void {
  lastHeartbeatAt.set(leadSid, nowMs)
}

/**
 * Start the host-neutral supervisor fallback timer for a lead session.
 * No-op inside workers (`ENV_RESULT_PATH` or `ENV_LEAD` set), when disabled,
 * or when already running for `leadSid`.
 */
export function startHeadlessSupervisor(ctx: HookHandlerContext): void {
  if (ctx.env.MINIMAL_AGENT_DISABLE_SUBAGENTS === "1") return
  if (ctx.env[ENV_RESULT_PATH]?.trim() || ctx.env[ENV_LEAD]?.trim()) return
  const leadSid = ctx.agent?.sessionId
  if (!leadSid || activeTimers.has(leadSid)) return

  let tick = 0
  const timer = setInterval(() => {
    const nowMs = Date.now()
    const lastHb = lastHeartbeatAt.get(leadSid) ?? 0
    if (nowMs - lastHb < HEARTBEAT_SILENCE_MS) return

    const liveCtx = {
      ...ctx,
      tick: ++tick,
    } as LiveAreaHandlerContext
    const deps = supervisorDepsFromCtx(liveCtx)
    if (!deps) return
    const hasActive = deps.store.all().some((r) => isActive(r.status))
    if (!hasActive) return
    try {
      runSupervisor(deps)
    } catch {
      // keep timer resilient
    }
  }, POLL_MS)
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    ;(timer as { unref?: () => void }).unref?.()
  }
  activeTimers.set(leadSid, timer)
}

/** Stop the fallback supervisor timer and clear heartbeat tracking for `leadSid`. */
export function stopHeadlessSupervisor(leadSid: string): void {
  const timer = activeTimers.get(leadSid)
  if (timer) {
    clearInterval(timer)
    activeTimers.delete(leadSid)
  }
  lastHeartbeatAt.delete(leadSid)
}
