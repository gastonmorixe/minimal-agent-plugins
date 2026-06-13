/**
 * Tool-call handler for `BackgroundRun`.
 *
 * Validates the input, resolves the timeout against config (ceiling + infinite
 * gate), starts a detached runner via the service, and returns IMMEDIATELY with
 * a handle. The job runs in the background, the model keeps working and is
 * nudged between turns when it finishes.
 *
 * Thin shell: validate, resolve config, service, render.
 *
 * @module handlers/bg_run
 */

import { loadBgConfig } from "../lib/config.ts"
import { formatDuration, parseDuration } from "../lib/duration.ts"
import { serviceDepsFromCtx } from "../lib/handler-deps.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { configureSgr, jobBlock, jobHeaderContent } from "../lib/render.ts"
import { startJob } from "../lib/service.ts"
import { parseRunRequest } from "../lib/validate.ts"

const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  configureSgr(ctx.env.MINIMAL_AGENT_PALETTE)

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
      content: "BackgroundRun: no session id available; cannot start a job.",
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
    `It runs in the background; you are NOT blocked. It ${timeoutNote}. ` +
    `Check it with BackgroundStatus ${rec.id} or read output with BackgroundLogs ${rec.id}; ` +
    `stop it with BackgroundStop ${rec.id}. You'll get a one-line digest between turns when it finishes.`

  const nowMs = Date.parse(rec.spawnedAt)
  return {
    kind: "tool_result",
    content,
    displayHeader: jobHeaderContent(rec, nowMs),
    display: jobBlock(rec, nowMs),
  }
}

export default handler
