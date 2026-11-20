/**
 * `prompt.submitted` handler: make one short AI title per session
 * (SPEC §4.2, §5, §6, §10).
 *
 * The manifest subscription declares `"host": true`, so the loader gives
 * `ctx.host` with only the manifest capabilities (`llm:complete`,
 * `sessions:meta`, `models:read`) and `ctx.run` (run-mode fact).
 *
 * Flow (the handler returns at once; the side call is not awaited):
 * 1. Eligibility (T1 `checkEligibility`, rules 1-8): run-mode gate (default
 *    ON only in the interactive REPL), captured sid, in-flight guard,
 *    slash, short text, `source:"user"`, max 2 attempts.
 * 2. Title state: `sessionMeta.getTitle(sid)`; a `user`/`ai` title → done.
 * 3. Model choice (`lib/model-select.ts`); none → no call, diagnostics
 *    `no-model` / `over-ceiling`.
 * 4. `llm.request` (one attempt, `timeoutMs`, `abortSignal: ctx.abort`).
 * 5. Validate + sanitize (T1 `validateTitleResult`).
 * 6. Late-result guard, then `sessionMeta.setTitle({sid: captured sid, …})`.
 * 7. After the write: one `title.saved` event (UI refresh signal, see
 *    {@link TITLE_SAVED_EVENT}).
 *
 * Failure is silent: debug log + one diagnostics event `title.attempt` per
 * attempt. A failed attempt leaves the sid open for one retry on the next
 * eligible prompt (SPEC §6 rule 8).
 *
 * @module handlers/on_prompt_submitted
 */

import {
  loadTitleConfig,
  readTitleEnv,
  resolveModelOverride,
  resolveTitleLanguage,
} from "../lib/config.ts"
import {
  checkEligibility,
  hasTitle,
  markFailure,
  markSuccess,
  startAttempt,
  type TitleSessionState,
} from "../lib/eligibility.ts"
import type {
  EventHandler,
  EventHandlerContext,
  LlmSideRequest,
  LlmSideResult,
  PromptSubmittedPayload,
  SessionTitleState,
  TitleHost,
} from "../lib/host-types.ts"
import { buildTitleInput } from "../lib/input.ts"
import { selectTitleModel } from "../lib/model-select.ts"
import { validateTitleResult } from "../lib/sanitize.ts"
import systemPromptText from "../prompts/system.md" with { type: "text" }

/** Log source and plugin id. */
const LOG_SOURCE = "title"

/** Diagnostics event name (SPEC §10, S4). */
export const TITLE_ATTEMPT_EVENT = "title.attempt"

/**
 * UI refresh event. The plugin emits it after `setTitle` wrote a title. A
 * live-area slot that names it in `refreshOn` runs at once, so the new title
 * shows without a wait for the next timer tick. The intercom footer slot
 * (`ma-intercom-plugin`, slot `intercom_beat`) does this.
 *
 * The name is a contract with the `refreshOn` list of that manifest. A test
 * in `tests/` checks that the two stay equal.
 */
export const TITLE_SAVED_EVENT = "title.saved"

/**
 * Payload of {@link TITLE_SAVED_EVENT}. It is a hint, not the source of
 * truth: core can change the text again when it writes the sidecar line. A
 * subscriber that paints the title reads it with `sessions.title(sid)`. This
 * also shows the title of a resumed session, for which no event comes.
 */
export interface TitleSavedEvent {
  sid: string
  title: string
  source: "ai"
}

/**
 * Max output tokens of the title call (SPEC §5.7 item 7). 80 title characters
 * in CJK text plus the JSON wrapper can be more than 128 tokens. The API bills
 * the real output, not the cap.
 */
export const TITLE_MAX_TOKENS = 256

/**
 * The system prompt (SPEC §5.3), inlined by a text import. It holds all the
 * rules. The user message is the `<session>` block and one language line
 * (`buildTitleInput`), the same layout as Claude Code.
 */
export const SYSTEM_PROMPT = systemPromptText.trim()

/**
 * The output schema (SPEC §5.2). A constant: the provider caches the grammar.
 * The `description` is the STE form of the SPEC text, because the STE gate
 * does not accept the SPEC words (T2 deviation 2).
 */
export const TITLE_SCHEMA: Record<string, unknown> = Object.freeze({
  type: "object",
  properties: {
    title: { type: "string", description: "A title of 2 to 6 words" },
  },
  required: ["title"],
  additionalProperties: false,
})

/** One `title.attempt` diagnostics payload. */
export interface TitleAttemptEvent {
  sid: string
  purpose: "title"
  model?: string
  provider?: string
  latencyMs: number
  /**
   * Provider stop reason, or `no-model` / `over-ceiling` / `unusable` /
   * `exception` (the call threw) / `write-failed` (`setTitle` threw).
   */
  stopReason: string
  inputTokens: number
  outputTokens: number
  costUsd?: number
  /** True when a title line was written. */
  written: boolean
}

/** Options of {@link createTitleHandler} (tests). */
export interface TitleHandlerOptions {
  /** Clock for `failedAt`. Default `() => new Date()`. */
  now?: () => Date
}

/** A title handler with its state (tests read the state and wait for calls). */
export interface TitleHandlerInstance {
  handler: EventHandler
  /** Resolves when every started side call has ended. */
  idle(): Promise<void>
  /** The plugin state of `sid`. */
  stateFor(sid: string): TitleSessionState | undefined
}

function isPayload(v: unknown): v is PromptSubmittedPayload {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return typeof o.text === "string" && (o.sid === null || typeof o.sid === "string")
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The `code` of a host error (core `SessionMetaError`), when it has one. */
function errCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === "string" && code !== "" ? code : undefined
}

/** Parse the result JSON; fall back to the text when the host gave no `json`. */
function resultJson(res: LlmSideResult): unknown {
  if (res.json !== undefined) return res.json
  try {
    return JSON.parse(res.text)
  } catch {
    return undefined
  }
}

/** Make a handler with its own per-session state. */
export function createTitleHandler(opts: TitleHandlerOptions = {}): TitleHandlerInstance {
  const now = opts.now ?? (() => new Date())
  const states = new Map<string, TitleSessionState>()
  const pending = new Set<Promise<void>>()
  const seenConfigLines = new Set<string>()

  const handler: EventHandler = (ctx) => {
    try {
      start(ctx)
    } catch (err) {
      debug(ctx, `handler error: ${errText(err)}`)
    }
  }

  function debug(ctx: EventHandlerContext, msg: string): void {
    try {
      ctx.log.debug(LOG_SOURCE, msg)
    } catch {
      /* a broken logger must not throw */
    }
  }

  function emitAttempt(ctx: EventHandlerContext, ev: TitleAttemptEvent): void {
    try {
      ctx.emit(TITLE_ATTEMPT_EVENT, ev)
    } catch {
      /* diagnostics are best effort */
    }
  }

  function emitSaved(ctx: EventHandlerContext, ev: TitleSavedEvent): void {
    try {
      ctx.emit(TITLE_SAVED_EVENT, ev)
    } catch {
      /* a refresh signal is best effort: the next timer tick shows the title */
    }
  }

  function start(ctx: EventHandlerContext): void {
    const env: NodeJS.ProcessEnv = { ...ctx.env }
    const config = loadTitleConfig(env, (line) => {
      if (seenConfigLines.has(line)) return
      seenConfigLines.add(line)
      debug(ctx, line)
    })
    const payload = ctx.payload
    if (!isPayload(payload)) return

    const sidKey = typeof payload.sid === "string" ? payload.sid.trim() : ""
    const base = {
      payload,
      ctxSid: ctx.agent?.sessionId,
      state: states.get(sidKey),
      run: ctx.run,
      config,
      env,
    }
    const pre = checkEligibility(base)
    if (!pre.eligible) {
      if (pre.rule > 1) debug(ctx, `skip sid=${pre.sid ?? "-"} rule=${pre.rule} ${pre.reason}`)
      return
    }
    const sid = pre.sid

    const host: TitleHost | undefined = ctx.host
    const request = host?.llm?.request
    const meta = host?.sessionMeta
    if (!host || !request || !meta) {
      debug(ctx, `skip sid=${sid}: host has no llm.request or sessionMeta`)
      return
    }

    // Rule 4 with the real title state (resume, user title).
    let titleState: SessionTitleState
    try {
      titleState = meta.getTitle(sid)
    } catch (err) {
      debug(ctx, `skip sid=${sid}: getTitle failed: ${errText(err)}`)
      return
    }
    if (hasTitle(titleState)) {
      states.set(sid, markSuccess(states.get(sid)))
      debug(ctx, `skip sid=${sid}: a title exists`)
      return
    }

    // Model choice (SPEC §4.3): the provider title profile only. Live
    // provider: run fact, else the boot model.
    const models = host.models
    const agentModel = ctx.agent?.model
    let sessionProviderId = ctx.run?.providerId
    if (!sessionProviderId && agentModel && models) {
      try {
        sessionProviderId = models.find(agentModel)?.providerId
      } catch {
        sessionProviderId = undefined
      }
    }
    const titleEnv = readTitleEnv(env)
    const choice = selectTitleModel({
      models,
      sessionProviderId,
      override: resolveModelOverride(config, titleEnv),
      ...(config.effort ? { effort: config.effort } : {}),
      maxUsdPerMTokIn: config.maxUsdPerMTokIn,
    })

    // Rule 9: the attempt starts here (also when no model is found, so the
    // no-model path is bounded by the same 2-attempt limit).
    states.set(sid, startAttempt(states.get(sid)))

    if (!choice.ok) {
      states.set(sid, markFailure(states.get(sid), now()))
      const why = choice.rejected.map((r) => `${r.step}:${r.modelId}:${r.reason}`).join(",")
      debug(ctx, `no title sid=${sid}: ${choice.reason}${why ? ` (${why})` : ""}`)
      emitAttempt(ctx, {
        sid,
        purpose: "title",
        provider: sessionProviderId,
        latencyMs: 0,
        stopReason: choice.reason,
        inputTokens: 0,
        outputTokens: 0,
        written: false,
      })
      return
    }

    const req: LlmSideRequest = {
      purpose: "title",
      model: choice.modelId,
      system: SYSTEM_PROMPT,
      userText: buildTitleInput(pre.text, resolveTitleLanguage(config, titleEnv)),
      maxTokens: TITLE_MAX_TOKENS,
      timeoutMs: config.timeoutMs,
      thinking: "off",
      ...(choice.effort ? { effort: choice.effort } : {}),
      outputSchema: { name: "session_title", schema: TITLE_SCHEMA, strict: true },
      abortSignal: ctx.abort,
      maxUsdPerMTokIn: config.maxUsdPerMTokIn,
    }

    const job = runCall(ctx, sid, choice.providerId, req, request.bind(host.llm), meta)
    pending.add(job)
    void job.finally(() => pending.delete(job))
  }

  async function runCall(
    ctx: EventHandlerContext,
    sid: string,
    providerId: string,
    req: LlmSideRequest,
    request: (r: LlmSideRequest) => Promise<LlmSideResult>,
    meta: NonNullable<TitleHost["sessionMeta"]>,
  ): Promise<void> {
    const started = Date.now()
    const ev: TitleAttemptEvent = {
      sid,
      purpose: "title",
      model: req.model,
      provider: providerId,
      latencyMs: 0,
      stopReason: "exception",
      inputTokens: 0,
      outputTokens: 0,
      written: false,
    }
    /** True after the call ended and `setTitle` started. */
    let writing = false
    try {
      const res = await request(req)
      ev.model = res.model || req.model
      ev.provider = res.provider || providerId
      ev.latencyMs = typeof res.latencyMs === "number" ? res.latencyMs : Date.now() - started
      ev.stopReason = res.stopReason
      ev.inputTokens = res.usage?.inputTokens ?? 0
      ev.outputTokens = res.usage?.outputTokens ?? 0
      if (res.costUsd !== undefined) ev.costUsd = res.costUsd

      const valid = validateTitleResult({ stopReason: res.stopReason, json: resultJson(res) })
      if (!valid.ok) {
        if (valid.reason !== "stop-reason") ev.stopReason = "unusable"
        states.set(sid, markFailure(states.get(sid), now()))
        const extra = res.reason ? ` reason=${res.reason}` : ""
        debug(ctx, `no title sid=${sid}: ${valid.reason} stop=${res.stopReason}${extra}`)
        return
      }

      // Late-result guard (SPEC §6): a title (user or ai) appeared meanwhile.
      if (hasTitle(meta.getTitle(sid))) {
        states.set(sid, markSuccess(states.get(sid)))
        debug(ctx, `drop title sid=${sid}: a title exists`)
        return
      }

      // Core `setTitle` throws `SessionMetaError` (`not-owned`,
      // `no-session-file`, `write-failed`). The catch then reports
      // `write-failed`, not the provider stop reason.
      writing = true
      await meta.setTitle({
        sid,
        title: valid.title,
        source: "ai",
        model: ev.model,
        provider: ev.provider,
        usage: {
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}),
        },
      })
      ev.written = true
      states.set(sid, markSuccess(states.get(sid)))
      const cost = ev.costUsd !== undefined ? ` $${ev.costUsd.toFixed(6)}` : ""
      debug(
        ctx,
        `title sid=${sid} model=${ev.model} in=${ev.inputTokens} out=${ev.outputTokens}${cost} ${ev.latencyMs}ms`,
      )
      // After the write: a subscriber that reads the title finds it. The emit
      // has its own `try`, so it cannot turn a good write into `write-failed`.
      emitSaved(ctx, { sid, title: valid.title, source: "ai" })
    } catch (err) {
      if (!writing) ev.latencyMs = Date.now() - started
      ev.stopReason = writing ? "write-failed" : "exception"
      ev.written = false
      states.set(sid, markFailure(states.get(sid), now()))
      const code = errCode(err)
      debug(
        ctx,
        `no title sid=${sid}: ${ev.stopReason}${code ? ` code=${code}` : ""}: ${errText(err)}`,
      )
    } finally {
      emitAttempt(ctx, ev)
    }
  }

  return {
    handler,
    async idle(): Promise<void> {
      while (pending.size > 0) await Promise.allSettled([...pending])
    },
    stateFor: (sid) => states.get(sid),
  }
}

const instance = createTitleHandler()

/** The handler that the manifest names (`export: "default"`). */
const onPromptSubmitted: EventHandler = instance.handler

export default onPromptSubmitted
