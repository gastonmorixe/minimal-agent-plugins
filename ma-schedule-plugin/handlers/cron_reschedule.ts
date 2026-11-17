/**
 * `CronReschedule` tool — adjust the next fire time for a scheduled task.
 *
 * The model calls this to speed up or slow down a /loop (or any dynamic
 * task) without canceling and re-creating it. Accepts EITHER `every` (a
 * human interval like "30s", "10m") to re-arm at a new cadence, OR
 * `nextAtMs` to set an absolute epoch-ms fire time.
 *
 * `every` switches the task to the dynamic pace: the heartbeat re-arms
 * `nextAtMs = now + intervalMs` after each fire, so the task gets a new
 * steady cadence. `nextAtMs` is single-use and keeps the existing cadence:
 * a cron task fires once at it and then continues on its cron, a dynamic
 * task re-arms by its own interval, and a one-shot just moves.
 *
 * @module schedule/handlers/cron_reschedule
 */

import { cadenceLabel, clockHHMMSS, taskFooter, taskInfo, wrapText } from "../lib/format.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { parseDurationMs } from "../lib/interval.ts"
import { type CronEntry, cronStoreForSession } from "../lib/store.ts"

/** Tool handler for CronReschedule. See the file-level doc. */
export default async function cronReschedule(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.env.MINIMAL_AGENT_DISABLE_CRON === "1") {
    return {
      kind: "tool_result",
      content: "Scheduling is disabled (MINIMAL_AGENT_DISABLE_CRON=1).",
      is_error: true,
    }
  }
  const sid = ctx.agent?.sessionId
  if (!sid)
    return {
      kind: "tool_result",
      content: "Scheduling requires an active session id.",
      is_error: true,
    }

  const input = ctx.trigger.type === "tool" ? ctx.trigger.input : {}
  const id = String(input.id ?? "").trim()
  if (!id) return { kind: "tool_result", content: "`id` is required.", is_error: true }

  const rawEvery = typeof input.every === "string" ? input.every.trim() : ""
  const rawNextAtMs = typeof input.nextAtMs === "number" ? input.nextAtMs : null

  if (!rawEvery && rawNextAtMs === null) {
    return {
      kind: "tool_result",
      content: 'Provide either `every` (e.g. "30s", "10m") or `nextAtMs` (absolute epoch ms).',
      is_error: true,
    }
  }

  const store = cronStoreForSession(sid, ctx.env)
  const entries = store.load()
  const idx = entries.findIndex((e) => e.id === id)
  if (idx === -1) {
    return {
      kind: "tool_result",
      content: `No scheduled task with id "${id}". Use CronList to see current ids.`,
      is_error: true,
    }
  }

  const now = Date.now()
  const entry = entries[idx]
  // `nextAtMs` alone keeps the pace: a cron task fires once at it, then
  // goes back to its cron (the scheduler clears the override). Only `every`
  // switches the task to the dynamic pace with a new interval.
  const updated: CronEntry = { ...entry }

  if (rawEvery) {
    const ms = parseDurationMs(rawEvery)
    if (ms === null || ms < 1000) {
      return {
        kind: "tool_result",
        content: `Could not parse interval "${rawEvery}" (try e.g. "30s", "5m", "2h").`,
        is_error: true,
      }
    }
    updated.pace = "dynamic"
    updated.intervalMs = ms
    updated.nextAtMs = now + ms
    updated.label = rawEvery
  } else if (rawNextAtMs !== null) {
    if (rawNextAtMs <= now) {
      return {
        kind: "tool_result",
        content: `nextAtMs (${rawNextAtMs}) is in the past. The task would fire immediately. Use a future timestamp.`,
        is_error: true,
      }
    }
    updated.nextAtMs = rawNextAtMs
  }

  entries[idx] = updated
  store.replaceAll(entries)

  const e = updated
  const info = taskInfo(e, now)
  const body = wrapText(`Rescheduled. Next fire at ${clockHHMMSS(e.nextAtMs ?? now)}`, 72)
  // A fixed recurring task keeps its cron after the single-use fire.
  const backOnCron = e.pace !== "dynamic" && e.recurs
  if (e.intervalMs) {
    const label = rawEvery || `${Math.round(e.intervalMs / 1000)}s`
    body.push(`New cadence: every ${label}`)
  } else if (backOnCron) {
    body.push(`Then back on its schedule: ${cadenceLabel(e)}`)
  }

  const tail = e.intervalMs
    ? `, every ~${Math.round(e.intervalMs / 1000)}s`
    : backOnCron
      ? `, then back on its schedule (${cadenceLabel(e)})`
      : ""
  return {
    kind: "tool_result",
    content: `Rescheduled task ${id}. Next fire at ${clockHHMMSS(e.nextAtMs ?? now)}${tail}.`,
    display: body.join("\n"),
    displayHeader: info,
    displayFooter: taskFooter(e, now),
  }
}
