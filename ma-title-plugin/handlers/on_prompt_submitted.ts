/**
 * `prompt.submitted` handler: make one short AI title per session
 * (SPEC §4.2, §5, §6, §10).
 *
 * The manifest subscription declares `"host": true`, so the loader gives
 * `ctx.host` with only the manifest capabilities (`llm:complete`,
 * `sessions:meta`, `sessions:read`, `models:read`) and `ctx.run` (run-mode
 * fact).
 *
 * Flow (the handler returns at once; the side call is not awaited):
 * 1. Eligibility (T1 `checkEligibility`, rules 1-8): run-mode gate (default
 *    ON only in the interactive REPL), captured sid, in-flight guard,
 *    slash (a `/name args` line gives its args), short text,
 *    `source:"user"`, max 2 attempts, backoff after a transient failure.
 * 2. Title state: `sessionMeta.getTitle(sid)`; a `user`/`ai` title → done.
 *    The first eligible text is kept for each sid (each attempt sends it).
 * 3. Fork check, one time for each sid (`sessions.meta`, async): when the
 *    parent has a title, copy it as an `ai` title. No model call.
 * 4. Model choice (`lib/model-select.ts`); none → no call and no attempt
 *    used, diagnostics `no-model` / `over-ceiling` one time for each sid.
 * 5. `llm.request` (one attempt, `timeoutMs`, `abortSignal: ctx.abort`).
 * 6. Validate + sanitize (T1 `validateTitleResult`).
 * 7. Late-result guard, then `sessionMeta.setTitle({sid: captured sid, …})`.
 * 8. After the write: one `title.saved` event (UI refresh signal, see
 *    {@link TITLE_SAVED_EVENT}).
 *
 * Failure is silent: debug log + one diagnostics event `title.attempt` per
 * attempt. `lib/retry.ts` puts each failure in a class. A transient failure
 * uses no attempt: the next eligible prompt after the backoff tries again,
 * with no limit. A final failure uses an attempt: one retry on the next
 * eligible prompt (SPEC §6 rule 8).
 *
 * @module handlers/on_prompt_submitted
 */

import { loadTitleConfig, type TitleConfig } from "../lib/config.ts"
import {
  checkEligibility,
  hasTitle,
  initialTitleState,
  MAX_ATTEMPTS,
  markBusy,
  markFailure,
  markIdle,
  markSuccess,
  markTransientFailure,
  startAttempt,
  type TitleSessionState,
} from "../lib/eligibility.ts"
import {
  buildTitleRequest,
  checkTitleResult,
  chooseTitleModel,
  pasteSourceFor,
  TITLE_SAVED_EVENT,
  type TitleSavedEvent,
  titleLanguage,
} from "../lib/generate.ts"
import type {
  EventHandler,
  EventHandlerContext,
  LlmCompleteApi,
  LlmSideRequest,
  LlmSideResult,
  PromptSubmittedPayload,
  SessionMetaApi,
  SessionsReadApi,
  SessionTitleState,
  TitleHost,
  TitleSideband,
} from "../lib/host-types.ts"
import { wrapCleanText } from "../lib/input.ts"
import { classifyFailure, type FailureClass, type FailureInput } from "../lib/retry.ts"
import { createTitleShared, defaultTitleShared, type TitleShared } from "../lib/shared.ts"

export {
  SYSTEM_PROMPT,
  TITLE_MAX_TOKENS,
  TITLE_SAVED_EVENT,
  TITLE_SCHEMA,
  type TitleSavedEvent,
} from "../lib/generate.ts"

/** Log source and plugin id. */
const LOG_SOURCE = "title"

/** Diagnostics event name (SPEC §10, S4). */
export const TITLE_ATTEMPT_EVENT = "title.attempt"

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
  /**
   * On a failed call only: `transient` (no attempt used, a retry after the
   * backoff) or `final` (one attempt used). See `lib/retry.ts`.
   */
  retry?: FailureClass
}

/** Options of {@link createTitleHandler} (tests). */
export interface TitleHandlerOptions {
  /** Clock for `failedAt` and the backoff. Default `() => new Date()`. */
  now?: () => Date
  /**
   * The state that the handler shares with the `SessionTitle` tool. Default:
   * a new state for each handler. The module default handler uses
   * `defaultTitleShared`.
   */
  shared?: TitleShared
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

/** Make a handler with its own per-session state. */
export function createTitleHandler(opts: TitleHandlerOptions = {}): TitleHandlerInstance {
  const now = opts.now ?? (() => new Date())
  const shared = opts.shared ?? createTitleShared()
  const states = shared.states
  const pending = new Set<Promise<void>>()
  const seenConfigLines = new Set<string>()
  /** True after the "no sideband codec" debug line (one time). */
  let noSidebandLogged = false

  const handler: EventHandler = (ctx) => {
    // The tool context has no `emit`: keep the bus emit for the tool.
    if (typeof ctx.emit === "function") shared.emit = ctx.emit
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
    // The codec strips the internal tags. With no codec (an old host), a
    // tag could go to the model: make no title.
    const sb = ctx.sideband
    if (!sb?.ready) {
      if (!noSidebandLogged) debug(ctx, "skip: host has no sideband codec")
      noSidebandLogged = true
      return
    }

    const sidKey = typeof payload.sid === "string" ? payload.sid.trim() : ""
    const base = {
      payload,
      ctxSid: ctx.agent?.sessionId,
      state: states.get(sidKey),
      run: ctx.run,
      config,
      env,
      sb,
      // Part A: a paste ref gets the text of its file (`lib/paste.ts`).
      pasteSource: (sid: string) => pasteSourceFor(ctx.host, sid),
      now: now(),
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

    // B5: keep the first eligible text. Each attempt and retry sends it.
    const prev = states.get(sid) ?? initialTitleState()
    states.set(sid, { ...prev, firstText: prev.firstText ?? pre.text })

    // B2: a fork or a resume gets the title of its parent (no model call).
    // `meta` is async: `inFlight` is set now, so a prompt that comes during
    // the check stops at rule 3.
    const sessions = host.sessions
    if (sessions && !prev.parentChecked) {
      states.set(sid, { ...markBusy(states.get(sid)), parentChecked: true })
      const job = (async () => {
        try {
          if (await inheritParentTitle(ctx, sid, sessions, meta)) return
        } catch (err) {
          debug(ctx, `no parent title sid=${sid}: ${errText(err)}`)
        }
        startModelCall(ctx, sid, host, request, meta, config, env, sb)
      })().catch((err) => {
        states.set(sid, markIdle(states.get(sid)))
        debug(ctx, `handler error sid=${sid}: ${errText(err)}`)
      })
      track(job)
      return
    }
    startModelCall(ctx, sid, host, request, meta, config, env, sb)
  }

  function track(job: Promise<void>): void {
    pending.add(job)
    void job.finally(() => pending.delete(job))
  }

  /**
   * B2: copy the title of the parent session. Returns true when the sid has
   * a title now (copied, or written meanwhile). A throw goes to the caller,
   * which then uses the normal path.
   */
  async function inheritParentTitle(
    ctx: EventHandlerContext,
    sid: string,
    sessions: SessionsReadApi,
    meta: SessionMetaApi,
  ): Promise<boolean> {
    const view = await sessions.meta(sid)
    const parentSid = view?.parentSid?.trim() ?? ""
    if (parentSid === "" || parentSid === sid) return false
    const title = sessions.title(parentSid)?.trim() ?? ""
    if (title === "") return false
    // Late guard: a title (user or ai) appeared during the read.
    if (hasTitle(meta.getTitle(sid))) {
      states.set(sid, markSuccess(states.get(sid)))
      debug(ctx, `drop parent title sid=${sid}: a title exists`)
      return true
    }
    await meta.setTitle({ sid, title, source: "ai" })
    states.set(sid, markSuccess(states.get(sid)))
    debug(ctx, `title sid=${sid} from parent=${parentSid}`)
    emitSaved(ctx, { sid, title, source: "ai" })
    return true
  }

  /** Model choice, then one side call (not awaited). */
  function startModelCall(
    ctx: EventHandlerContext,
    sid: string,
    host: TitleHost,
    request: NonNullable<LlmCompleteApi["request"]>,
    meta: SessionMetaApi,
    config: TitleConfig,
    env: NodeJS.ProcessEnv,
    sb: TitleSideband,
  ): void {
    // Model choice (SPEC §4.3): `lib/generate.ts`, shared with the tool.
    const { choice, sessionProviderId } = chooseTitleModel({
      models: host.models,
      run: ctx.run,
      agentModel: ctx.agent?.model,
      config,
      env,
    })

    // B4: no model → no call, and no attempt is used. The log line and the
    // `title.attempt` event come one time for each sid.
    if (!choice.ok) {
      const s = states.get(sid) ?? initialTitleState()
      states.set(sid, { ...markIdle(s), noModelReported: true })
      if (s.noModelReported) return
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

    // Rule 9: the attempt starts here.
    states.set(sid, startAttempt(states.get(sid)))
    const text = states.get(sid)?.firstText ?? ""

    // `firstText` is clean already (the eligibility clean step expanded the
    // paste refs). Do not clean it again.
    const userText = wrapCleanText(text, titleLanguage(config, env))
    const req = buildTitleRequest(choice, userText, config, ctx.abort)

    track(runCall(ctx, sid, choice.providerId, req, request.bind(host.llm), meta, sb))
  }

  /**
   * Record a failed call: classify it, change the state, set `ev.retry`,
   * and give the log text for the class and the next try.
   */
  function recordFailure(sid: string, ev: TitleAttemptEvent, input: FailureInput): string {
    const cls = classifyFailure(input)
    const at = now()
    ev.retry = cls
    if (cls === "transient") {
      const s = markTransientFailure(states.get(sid), at)
      states.set(sid, s)
      const next = s.retryAfter !== undefined ? new Date(s.retryAfter).toISOString() : "-"
      return `retry=transient n=${s.transientFailures ?? 0} next=${next}`
    }
    const s = markFailure(states.get(sid), at)
    states.set(sid, s)
    const next = s.attempts < MAX_ATTEMPTS ? "next-prompt" : "none"
    return `retry=final attempts=${s.attempts}/${MAX_ATTEMPTS} next=${next}`
  }

  async function runCall(
    ctx: EventHandlerContext,
    sid: string,
    providerId: string,
    req: LlmSideRequest,
    request: (r: LlmSideRequest) => Promise<LlmSideResult>,
    meta: SessionMetaApi,
    sb: TitleSideband,
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

      const valid = checkTitleResult(res, sb)
      if (!valid.ok) {
        if (valid.reason !== "stop-reason") ev.stopReason = "unusable"
        const retry = recordFailure(sid, ev, {
          kind: "result",
          stopReason: res.stopReason,
          ...(res.reason ? { reason: res.reason } : {}),
          ...(res.detail ? { detail: res.detail } : {}),
        })
        const extra = res.reason ? ` reason=${res.reason}` : ""
        debug(ctx, `no title sid=${sid}: ${valid.reason} stop=${res.stopReason}${extra} ${retry}`)
        return
      }

      // Late-result guard (SPEC §6): a title (user or ai) appeared meanwhile,
      // or the `SessionTitle` tool marked the sid done (its write can still
      // be in flight, so `getTitle` does not show it yet).
      if (states.get(sid)?.done || hasTitle(meta.getTitle(sid))) {
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
      const code = errCode(err)
      const retry = recordFailure(
        sid,
        ev,
        writing
          ? { kind: "write-failed", ...(code ? { code } : {}) }
          : { kind: "exception", error: err },
      )
      debug(
        ctx,
        `no title sid=${sid}: ${ev.stopReason}${code ? ` code=${code}` : ""}: ${errText(err)} ${retry}`,
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

const instance = createTitleHandler({ shared: defaultTitleShared })

/** The handler that the manifest names (`export: "default"`). */
const onPromptSubmitted: EventHandler = instance.handler

export default onPromptSubmitted
