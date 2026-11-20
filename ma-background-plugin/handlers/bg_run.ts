/**
 * Tool-call handler for `BackgroundRun`.
 *
 * Validates the input, resolves the timeout against config (ceiling + infinite
 * gate), starts a detached runner via the service, and returns IMMEDIATELY with
 * a handle. The job runs in the background, the model keeps working and is
 * nudged between turns when it finishes. In a headless run (`-p`,
 * `stream-json`, a worker) the `turn.willStop` hook keeps the turn open
 * instead, and the result says so.
 *
 * Thin shell: validate, resolve config, service, render.
 *
 * @module handlers/bg_run
 */

import { loadBgConfig } from "../lib/config.ts"
import { formatDuration, parseDuration } from "../lib/duration.ts"
import { serviceDepsFromCtx } from "../lib/handler-deps.ts"
import { isHeadlessRun, waitDisabled } from "../lib/headless-wait.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { jobBlock, jobHeaderContent } from "../lib/render.ts"
import { startJob } from "../lib/service.ts"
import { parseRunRequest } from "../lib/validate.ts"

const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "BackgroundRun: wrong trigger type", is_error: true }
  }

  const config = loadBgConfig(ctx.env as NodeJS.ProcessEnv)
  if (!config.enabled) {
    return {
      kind: "tool_result",
      content:
        'BackgroundRun: the background plugin is disabled in user config (plugins["ma-bg"].enabled = false).',
      is_error: true,
    }
  }

  const parsed = parseRunRequest(ctx.trigger.input)
  if (!parsed.ok) {
    return { kind: "tool_result", content: `BackgroundRun: ${parsed.error}`, is_error: true }
  }
  const req = parsed.value

  // Resolve the timeout against config: friendly string -> ms, clamped to the
  // ceiling, infinite gated by config.
  const dur = parseDuration(req.timeout, {
    defaultMs: config.defaults.timeoutMs,
    maxMs: config.defaults.maxTimeoutMs,
    allowInfinite: config.defaults.allowInfinite,
  })
  if (!dur.ok) {
    return { kind: "tool_result", content: `BackgroundRun: ${dur.error}`, is_error: true }
  }

  const deps = serviceDepsFromCtx(ctx, config)
  if (!deps) {
    return {
      kind: "tool_result",
      content: "BackgroundRun: no session id available. Cannot start a job.",
      is_error: true,
    }
  }

  const r = startJob(
    {
      command: req.command,
      ...(req.description ? { description: req.description } : {}),
      cwd: req.cwd ?? ctx.cwd,
      timeoutMs: dur.value.ms,
    },
    deps,
  )
  if (!r.ok) return { kind: "tool_result", content: `BackgroundRun: ${r.error}`, is_error: true }

  const rec = r.value
  const timeoutNote = dur.value.infinite
    ? "no timeout"
    : `times out in ${formatDuration(rec.timeoutMs)}${dur.value.clamped ? " (clamped to the max)" : ""}`
  const content =
    `Started background job ${rec.id} (pid ${rec.runnerPid}): \`${rec.command}\`. ` +
    `It runs in the background. You are not blocked. It ${timeoutNote}. ` +
    `Check it with BackgroundStatus ${rec.id} or read output with BackgroundLogs ${rec.id}. ` +
    `Stop it with BackgroundStop ${rec.id}. ${finishNote(ctx)}`

  const nowMs = Date.parse(rec.spawnedAt)
  return {
    kind: "tool_result",
    content,
    displayHeader: jobHeaderContent(rec, nowMs),
    display: jobBlock(rec, nowMs),
  }
}

/** The headless note (ASD-STE100): a headless run has no digest between turns. */
export const HEADLESS_NOTE =
  "This run is headless: the turn stays open until the job is complete. Do the other work, or read the job with BackgroundLogs."

/** The last sentence of the result: the digest note, or the headless note. */
function finishNote(ctx: TUIContext): string {
  // The core gives `ctx.run` on a tool context. An older core gives none:
  // then only the worker env decides.
  if (isHeadlessRun(ctx.run, undefined, ctx.env) && !waitDisabled(ctx.env)) return HEADLESS_NOTE
  return "You'll get a one-line digest between turns when it finishes."
}

export default handler
