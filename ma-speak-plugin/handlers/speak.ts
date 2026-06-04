/**
 * Tool-call handler for `Speak`.
 *
 * Pipeline:
 *   1. Validate `ctx.trigger.input` (text, wait).
 *   2. Load plugin config from `~/.minimal-agent/config.jsonc`.
 *   3. Spawn the configured speech backend DETACHED via `lib/backend.ts`.
 *   4. Register the job in the in-process registry, returning a handle `s1`.
 *   5. Wire the backend's exit to the registry reaper (done / failed).
 *   6. Return immediately (`wait: false`), or block until the speech finishes
 *      or the wait budget elapses (`wait: true`).
 *
 * The crucial difference from a normal tool: speech OUTLIVES this call. We do
 * not await the process in the default path; we hand back a handle and let the
 * audio keep playing while the agent works. `SpeakStatus` / `SpeakStop` (other
 * tools, sharing the same module-singleton registry) address the job later.
 *
 * Backend-agnostic by contract: nothing here, and nothing in any returned
 * string, names a specific speech engine. Engine identity lives only in
 * operator config + the plugin README.
 *
 * @module handlers/speak
 */

import { type SpeechDeps, spawnSpeech } from "../lib/backend.ts"
import { loadSpeakConfig, type SpeakConfig } from "../lib/config.ts"
import { classifySpeechFailure, engineUnavailable } from "../lib/errors.ts"
import { getRegistry, type SpeechJob, type SpeechRegistry } from "../lib/registry.ts"
import { dim, red, renderFooter, renderJobLine } from "../lib/render.ts"
import type { TUIContext, TUIResult } from "../lib/types.ts"

export interface ParsedSpeakInput {
  text: string
  wait: boolean
}

export type ValidateResult = { ok: true; value: ParsedSpeakInput } | { ok: false; error: string }

/**
 * Validate raw tool input against config (for the char cap). Returns parsed
 * values or an error message. Pure apart from reading `config.defaults`.
 */
export function validateInput(raw: Record<string, unknown>, config: SpeakConfig): ValidateResult {
  if (typeof raw.text !== "string") {
    return { ok: false, error: "`text` is required and must be a string" }
  }
  const text = raw.text
  if (text.trim().length === 0) {
    return { ok: false, error: "`text` must not be empty or whitespace-only" }
  }
  if (text.length > config.defaults.maxChars) {
    return {
      ok: false,
      error: `\`text\` is ${text.length} characters; the limit is ${config.defaults.maxChars}. Speak a shorter passage or split it across calls.`,
    }
  }

  let wait = false
  if (raw.wait !== undefined) {
    if (typeof raw.wait !== "boolean") {
      return { ok: false, error: "`wait` must be a boolean" }
    }
    wait = raw.wait
  }

  return { ok: true, value: { text, wait } }
}

/** Default export: the tool handler the loader invokes. */
const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "Speak: wrong trigger type", is_error: true }
  }

  const config = loadSpeakConfig()
  if (!config.enabled) {
    return {
      kind: "tool_result",
      content:
        'Speak: the speak plugin is disabled in user config (plugins["ma-speak"].enabled = false).',
      is_error: true,
    }
  }

  const v = validateInput(ctx.trigger.input, config)
  if (!v.ok) {
    return {
      kind: "tool_result",
      content: `Speak: ${v.error}`,
      is_error: true,
      displayHeader: red("invalid input"),
      display: dim(v.error),
    }
  }

  return await runWithDeps(ctx, config, v.value, getRegistry(), {})
}

/**
 * Test-injectable inner. Exposed so handler tests pass a fake `spawnFn` /
 * `existsFn` via {@link SpeechDeps} and an explicit registry, without
 * spawning a real subprocess or touching the module singleton.
 *
 * `nowFn` defaults to `Date.now` and is only used for the transcript footer.
 */
export async function runWithDeps(
  ctx: TUIContext,
  config: SpeakConfig,
  input: ParsedSpeakInput,
  registry: SpeechRegistry,
  deps: SpeechDeps,
  nowFn: () => number = Date.now,
): Promise<TUIResult> {
  const spawn = spawnSpeech(ctx.packageDir, config, { text: input.text }, deps)

  if (!spawn.ok || !spawn.controller || !spawn.exited) {
    const failure = spawn.scriptMissing
      ? engineUnavailable()
      : classifySpeechFailure({ exitCode: -1, stderr: spawn.spawnError ?? "" })
    return speakErrorResult(failure.message)
  }

  const job = registry.register({
    controller: spawn.controller,
    backend: config.backend.replace(/\.ts$/, ""),
    text: input.text,
  })

  // Reaper: settle the registry job when the backend exits. Runs in the
  // background for `wait: false`; for `wait: true` we also await it below.
  const reaped = spawn.exited.then((exit) => {
    if (exit.killed) {
      // The process was signaled, not finished on its own: either a stop() we
      // issued (which already settled it to `stopped`) or the parent-exit hook
      // killing it as the agent exits. settle is monotonic, so this is a no-op
      // when stop() ran first, and otherwise records it as `stopped` (an
      // interruption), matching the state stop() would have set.
      registry.markStopped(job.id, exit.code)
      return
    }
    if (exit.code === 0) {
      registry.markDone(job.id, 0)
    } else {
      const failure = classifySpeechFailure({ exitCode: exit.code, stderr: exit.stderr })
      registry.markFailed(job.id, exit.code, failure.message)
    }
  })
  // Don't let an unhandled rejection escape if .then throws somehow.
  void reaped.catch(() => {})

  if (input.wait) {
    await waitForJob(spawn.exited, reaped, config.defaults.waitTimeoutSec, deps)
    const settled = registry.get(job.id) ?? job
    return speakResult(settled, nowFn(), { waited: true })
  }

  return speakResult(job, nowFn(), { waited: false })
}

/**
 * Block until the speech finishes or the wait budget elapses. Resolves either
 * way (never rejects). On timeout the job keeps playing in the background.
 */
async function waitForJob(
  exited: Promise<unknown>,
  reaped: Promise<void>,
  waitTimeoutSec: number,
  deps: SpeechDeps,
): Promise<void> {
  const setTimeoutFn =
    deps.setTimeoutFn ??
    (setTimeout as unknown as (cb: () => void, ms: number) => ReturnType<typeof setTimeout>)
  const clearTimeoutFn =
    deps.clearTimeoutFn ?? (clearTimeout as unknown as (h: ReturnType<typeof setTimeout>) => void)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeoutFn(() => resolve(), Math.max(1, waitTimeoutSec) * 1000)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  // Race the (reaped) completion against the timeout. We await `reaped` rather
  // than `exited` so the registry state is already settled when we return.
  await Promise.race([Promise.all([exited, reaped]).then(() => {}), timeout])
  if (timer) clearTimeoutFn(timer)
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

/** Build the model-facing `content` + transcript chrome for a started job. */
export function speakResult(job: SpeechJob, now: number, opts: { waited: boolean }): TUIResult {
  const content = speakContent(job, opts.waited)
  return {
    kind: "tool_result",
    content,
    display: renderJobLine(job, now),
    displayHeader: job.id,
    displayFooter: renderFooter(job),
  }
}

/** The string handed back to the model. Concise and actionable. */
export function speakContent(job: SpeechJob, waited: boolean): string {
  switch (job.state) {
    case "speaking":
      return (
        `Speaking now (job ${job.id}, ${job.charCount} chars). ` +
        `It plays in the background while you continue. ` +
        `Use SpeakStatus("${job.id}") to check progress or SpeakStop("${job.id}") to stop it.`
      )
    case "done":
      return waited
        ? `Done speaking (job ${job.id}). The full text was read aloud.`
        : `Speech job ${job.id} finished.`
    case "failed":
      return `Speech job ${job.id} failed: ${job.failureReason ?? "the text could not be spoken."}`
    case "stopped":
      return `Speech job ${job.id} was stopped before it finished.`
  }
}

/** Shape a backend-agnostic failure into an error `tool_result`. */
export function speakErrorResult(message: string): TUIResult {
  return {
    kind: "tool_result",
    content: `Speak: ${message}`,
    is_error: true,
    displayHeader: red("speech failed"),
    display: dim(message),
  }
}

export default handler
