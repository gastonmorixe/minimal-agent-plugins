/**
 * Tool-call handler for `BackgroundStop`.
 *
 * With an `id`, stops that one job, without, stops every running job (the "kill
 * them all" button). Stopping signals the runner (group-kill via the registry,
 * which tears down the job), records the index record as `stopped`, and is
 * idempotent: a stop on an already-terminal job is a no-op reported as such.
 *
 * The default signal is SIGTERM (the runner escalates to SIGKILL on its own);
 * the model can force SIGKILL.
 *
 * @module handlers/bg_stop
 */

import { storeFromCtx } from "../lib/handler-deps.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { getRegistry, type RunnerRegistry } from "../lib/registry.ts"
import { dim, jobLine, jobLines, yellow } from "../lib/render.ts"
import { BgJobStore } from "../lib/store.ts"
import { isActive, type JobRecord, type JobStatus } from "../lib/types.ts"
import { parseStopRequest } from "../lib/validate.ts"

const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "BackgroundStop: wrong trigger type", is_error: true }
  }

  const parsed = parseStopRequest(ctx.trigger.input)
  if (!parsed.ok) {
    return { kind: "tool_result", content: `BackgroundStop: ${parsed.error}`, is_error: true }
  }
  const req = parsed.value

  const store = storeFromCtx(ctx)
  if (!store) {
    return {
      kind: "tool_result",
      content: "BackgroundStop: no session id available.",
      is_error: true,
    }
  }

  const signal = req.signal ?? "SIGTERM"
  const reason = req.reason ?? "stopped by request"
  const registry = getRegistry()
  const nowMs = Date.now()

  if (req.id === undefined) {
    return stopAll(store, registry, signal, reason, nowMs)
  }

  const rec = store.get(req.id)
  if (!rec) {
    return {
      kind: "tool_result",
      content: `BackgroundStop: no job with handle "${req.id}" in this session.`,
      is_error: true,
    }
  }
  if (!isActive(rec.status)) {
    return {
      kind: "tool_result",
      content: `Job ${rec.id} was already ${rec.status.kind}; nothing to stop.`,
      displayHeader: rec.id,
      display: jobLine(rec, nowMs),
    }
  }

  const stopped = applyStop(store, registry, rec, signal, reason, nowMs)
  return {
    kind: "tool_result",
    content: `Stopped job ${rec.id} (signal ${signal}).`,
    displayHeader: yellow(`■ stopped ${rec.id}`),
    display: jobLine(stopped, nowMs),
  }
}

/** Mark one record stopped + signal its runner. Returns the updated record. */
function applyStop(
  store: BgJobStore,
  registry: RunnerRegistry,
  rec: JobRecord,
  signal: NodeJS.Signals,
  reason: string,
  nowMs: number,
): JobRecord {
  // Signal the live runner if we still hold it, otherwise fall back to a direct
  // group-kill of the recorded runner pid (e.g. after a resume where the pipe
  // is no longer held in-process).
  if (!registry.stop(rec.id, signal)) {
    const pid = Number(rec.runnerPid)
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        process.kill(pid, signal)
      } catch {
        // already gone
      }
    }
  }
  const status: JobStatus = { kind: "stopped", endedAt: new Date(nowMs).toISOString(), reason }
  const next: JobRecord = { ...rec, status }
  store.upsert(next)
  return next
}

/** Stop every running job. */
function stopAll(
  store: BgJobStore,
  registry: RunnerRegistry,
  signal: NodeJS.Signals,
  reason: string,
  nowMs: number,
): TUIResult {
  const active = store.all().filter((r) => isActive(r.status))
  if (active.length === 0) {
    return {
      kind: "tool_result",
      content: "No running background jobs; nothing to stop.",
      display: dim("(nothing running)"),
    }
  }
  const stopped = active.map((r) => applyStop(store, registry, r, signal, reason, nowMs))
  return {
    kind: "tool_result",
    content: `Stopped ${stopped.length} job(s): ${stopped.map((r) => r.id).join(", ")} (signal ${signal}).`,
    displayHeader: yellow(`■ stopped ${stopped.length}`),
    display: jobLines(stopped, nowMs),
  }
}

export default handler
