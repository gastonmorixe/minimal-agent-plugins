/**
 * Title eligibility and per-session state (SPEC §6, §7.1, §7.3, §7.4).
 *
 * Pure functions, no IO and no host call. The handler (T2) gets the values
 * (payload, run fact, config, env, title state) and calls
 * {@link checkEligibility}. Rules run in order, but the cheap source check
 * (rule 7), the attempt check (rule 8) and the backoff check (rule 8, reason
 * `backoff`) come before the clean step of rules 5 and 6. The first rule that
 * matches stops. Only rule 9 (start) uses an attempt.
 *
 * Retry policy (`lib/retry.ts`). A failed call is `transient` or `final`:
 *
 * 1. A transient failure (network, timeout, abort, rate limit, overload,
 *    HTTP 408 or 5xx) gives the attempt back. It adds 1 to
 *    `transientFailures` and sets `retryAfter` to now plus the backoff
 *    (1, 2, 5, 15, 30 min, then 60 min). There is no limit on transient
 *    failures.
 * 2. A final failure (a result that is not usable, a bad stop reason, a
 *    refusal, invalid JSON, a write error, an unknown error kind) uses the
 *    attempt. After {@link MAX_ATTEMPTS} final failures, the sid stops until
 *    the process starts again.
 * 3. A success resets `transientFailures` and `retryAfter`.
 *
 * A retry starts only on the next eligible prompt after `retryAfter`. The
 * plugin has no timer. Each retry sends `firstText`.
 *
 * @module lib/eligibility
 */

import {
  DEFAULT_ON_MODES,
  readTitleEnv,
  resolveTitleSwitch,
  type TitleArgs,
  type TitleConfig,
} from "./config.ts"
import type {
  PromptSubmittedPayload,
  RunMode,
  RunModeFact,
  SessionTitleState,
  TitleSideband,
} from "./host-types.ts"
import { cleanPromptText, codePointLength, hasMaTag } from "./input.ts"
import { PASTE_MISSING_MARKER, type PasteSource } from "./paste.ts"
import { backoffMs } from "./retry.ts"

/**
 * Max final failures per session per process: 1 attempt + 1 retry (SPEC §6
 * rule 8). A prompt with no model (`no-model`, `over-ceiling`) makes no call
 * and does not count. A transient failure does not count (`lib/retry.ts`).
 */
export const MAX_ATTEMPTS = 2

/** Env var that a sub-agent worker has (core `host-session-facts.ts`). */
export const SUBAGENT_ID_ENV = "MINIMAL_AGENT_SUBAGENT_ID"
/** Second env var that core and cli also accept for a sub-agent worker. */
export const SUBAGENT_SID_ENV = "MINIMAL_AGENT_SUBAGENT_SID"

/** Per-session state in plugin memory (key = sid). */
export interface TitleSessionState {
  /**
   * Attempts used for this sid (0, 1 or 2). A call in flight counts. A
   * transient failure gives its attempt back.
   */
  attempts: number
  /** Transient failures in a row. A final failure or a success resets it. */
  transientFailures?: number
  /**
   * Epoch ms. Before this time, a prompt makes no call (rule 8, `backoff`).
   * Set by a transient failure only.
   */
  retryAfter?: number
  /** True while a call runs. */
  inFlight: boolean
  /** True when a title exists or was written. */
  done: boolean
  /** ISO time of the last failure. */
  failedAt?: string
  /**
   * The clean text of the first eligible prompt (B5). Each attempt and each
   * retry sends this text, not the text of a later prompt.
   */
  firstText?: string
  /** True after the fork check (B2) ran for this sid. It runs one time. */
  parentChecked?: boolean
  /** True after the no-model log line and event (B4). They come one time. */
  noModelReported?: boolean
}

/** A new state for a sid. */
export function initialTitleState(): TitleSessionState {
  return { attempts: 0, inFlight: false, done: false }
}

/** Why the run mode gate is open or closed. */
export type ModeGateReason =
  | "plugin-disabled"
  | "no-run-fact"
  | "dry-run"
  | "kill-switch"
  | "subagent-off"
  | "subagent-derived"
  | "subagent-allowed"
  | "forced-on"
  | "config-modes"
  | "not-in-config-modes"
  | "default-on"
  | "default-off"

/** Result of {@link resolveModeGate}. */
export interface ModeGate {
  allowed: boolean
  reason: ModeGateReason
}

/** Input of {@link resolveModeGate}. */
export interface ModeGateInput {
  /** `ctx.run`. `undefined` (an old host) closes the gate. */
  run: RunModeFact | undefined
  config: TitleConfig
  /** The process env (for `MINIMAL_AGENT_TITLE` and the sub-agent id). */
  env: NodeJS.ProcessEnv
  /** CLI switches (P4). */
  args?: TitleArgs
}

/** True when this process is a sub-agent worker (run fact or env). */
export function isSubagentRun(run: RunModeFact | undefined, env: NodeJS.ProcessEnv): boolean {
  if (run?.mode === "subagent" || run?.subagent !== undefined) return true
  return [SUBAGENT_ID_ENV, SUBAGENT_SID_ENV].some((k) => (env[k]?.trim() ?? "") !== "")
}

/**
 * Rule 1: is a title call allowed in this run mode (SPEC §7.3)?
 *
 * Order: config `enabled:false` → off; no run fact → off; dry run → off;
 * kill switch (`--no-title` \> `MINIMAL_AGENT_TITLE=0`) → off; sub-agent
 * → off unless `subagents:"model"` and an opt-in; `--title` or
 * `MINIMAL_AGENT_TITLE=1` → on; `plugins.title.modes` set → on only for those
 * modes; else the defaults ({@link DEFAULT_ON_MODES}: `repl` in P1b; `repl`
 * also needs `interactive`).
 *
 * A sub-agent worker that inherits `MINIMAL_AGENT_TITLE=1` from the lead
 * stays off with the default `subagents:"off"` (IMPL-PLAN R8).
 */
export function resolveModeGate(input: ModeGateInput): ModeGate {
  const { run, config, env, args } = input
  if (!config.enabled) return { allowed: false, reason: "plugin-disabled" }
  if (run === undefined) return { allowed: false, reason: "no-run-fact" }
  if (run.dryRun === true) return { allowed: false, reason: "dry-run" }

  const forced = resolveTitleSwitch(args, readTitleEnv(env))
  if (forced === false) return { allowed: false, reason: "kill-switch" }

  if (isSubagentRun(run, env)) {
    if (config.subagents === "off") return { allowed: false, reason: "subagent-off" }
    // "derived": the catalog makes the title at read time; no model call.
    if (config.subagents === "derived") return { allowed: false, reason: "subagent-derived" }
    const optIn = forced === true || (config.modes?.includes("subagent") ?? false)
    return optIn
      ? { allowed: true, reason: "subagent-allowed" }
      : { allowed: false, reason: "default-off" }
  }

  if (forced === true) return { allowed: true, reason: "forced-on" }

  if (config.modes !== undefined) {
    return config.modes.includes(run.mode)
      ? { allowed: true, reason: "config-modes" }
      : { allowed: false, reason: "not-in-config-modes" }
  }

  return isDefaultOn(run.mode, run.interactive)
    ? { allowed: true, reason: "default-on" }
    : { allowed: false, reason: "default-off" }
}

/** SPEC §7.1 defaults: a mode in {@link DEFAULT_ON_MODES}; `repl` needs a TTY. */
function isDefaultOn(mode: RunMode, interactive: boolean): boolean {
  if (!DEFAULT_ON_MODES.includes(mode)) return false
  return mode !== "repl" || interactive
}

/** Why a prompt is not eligible. */
export type SkipReason =
  | `mode:${ModeGateReason}`
  | "no-sid"
  | "canceled"
  | "session-mismatch"
  | "done"
  | "in-flight"
  | "has-title"
  | "slash-command"
  | "synthetic-ma-only"
  | "too-short"
  | "source-not-user"
  | "max-attempts"
  | "backoff"

/** Input of {@link checkEligibility}. */
export interface EligibilityInput {
  /** The `prompt.submitted` payload. */
  payload: PromptSubmittedPayload
  /** `ctx.agent.sessionId` (scoped agent), when set. */
  ctxSid?: string
  /** Plugin state for `payload.sid`; `undefined` = a new sid. */
  state?: TitleSessionState
  /** `host.sessionMeta.getTitle(sid)`. `undefined` = not known (no title). */
  titleState?: SessionTitleState
  /** `ctx.run`. */
  run: RunModeFact | undefined
  config: TitleConfig
  env: NodeJS.ProcessEnv
  args?: TitleArgs
  /** `ctx.sideband`. It strips and finds the internal tags. */
  sb: TitleSideband
  /**
   * Where to read the paste files of the captured sid. Without it, each
   * self-closing paste ref gives the marker `(pasted text)`.
   */
  pasteSource?: (sid: string) => PasteSource | undefined
  /** The clock for the backoff check. Default: the time of the call. */
  now?: Date
}

/** Result of {@link checkEligibility}. */
export type Eligibility =
  | {
      eligible: true
      /** The captured sid. Use only this value for the state, read and write. */
      sid: string
      /** The clean prompt text (SPEC §5.4 clean step; not capped or wrapped). */
      text: string
    }
  | {
      eligible: false
      /** The SPEC §6 rule (1-8) that stopped the prompt. */
      rule: number
      reason: SkipReason
      /** The captured sid, when rule 2 passed. */
      sid?: string
      /** True for rule 4: the caller sets `state.done`. */
      markDone?: boolean
    }

/** True when the title state has a `user` or an `ai` title. */
export function hasTitle(titleState: SessionTitleState | undefined): boolean {
  const ai = titleState?.ai?.title?.trim() ?? ""
  const user = titleState?.user?.title?.trim() ?? ""
  return ai !== "" || user !== ""
}

/**
 * SPEC §6 rules 1-8. Pure: it does not change `state`. When the result is
 * eligible, the caller calls {@link startAttempt} (rule 9).
 */
export function checkEligibility(input: EligibilityInput): Eligibility {
  const { payload, state, config } = input

  // Rule 1: run mode.
  const gate = resolveModeGate(input)
  if (!gate.allowed) return { eligible: false, rule: 1, reason: `mode:${gate.reason}` }

  // Rule 2: sid capture and session-switch guard.
  const sid = typeof payload.sid === "string" ? payload.sid.trim() : ""
  if (sid === "") return { eligible: false, rule: 2, reason: "no-sid" }
  if (payload.exit === "canceled") return { eligible: false, rule: 2, reason: "canceled", sid }
  if (input.ctxSid && input.ctxSid !== sid) {
    return { eligible: false, rule: 2, reason: "session-mismatch", sid }
  }

  // Rule 3: one call per sid at a time; stop after a title.
  if (state?.done) return { eligible: false, rule: 3, reason: "done", sid }
  if (state?.inFlight) return { eligible: false, rule: 3, reason: "in-flight", sid }

  // Rule 4: a title exists (also covers resume).
  if (hasTitle(input.titleState)) {
    return { eligible: false, rule: 4, reason: "has-title", sid, markDone: true }
  }

  // Rules 7 and 8 come before the clean step: they are cheap, and the clean
  // step can read paste files. Each rule stops the prompt with no attempt, so
  // the order changes only the reason in the log, not the result.
  // Rule 7: only typed user text. A missing `source` (old core) stops too.
  if (payload.source !== "user") return { eligible: false, rule: 7, reason: "source-not-user", sid }

  // Rule 8: 1 attempt + 1 retry.
  if ((state?.attempts ?? 0) >= MAX_ATTEMPTS) {
    return { eligible: false, rule: 8, reason: "max-attempts", sid }
  }

  // Rule 8 (backoff): after a transient failure, wait until `retryAfter`.
  const retryAfter = state?.retryAfter
  if (retryAfter !== undefined && (input.now ?? new Date()).getTime() < retryAfter) {
    return { eligible: false, rule: 8, reason: "backoff", sid }
  }

  const rawText = typeof payload.text === "string" ? payload.text : ""
  let text = cleanPromptText(rawText, input.sb, { source: input.pasteSource?.(sid) })

  // Rule 5: slash command. A simple `/name args` line gives its args as the
  // title text, when the args pass rule 6. Each other slash line stops.
  if (text.startsWith("/")) {
    const args = slashCommandArgs(text)
    if (args === undefined || codePointLength(args) < config.minChars) {
      return { eligible: false, rule: 5, reason: "slash-command", sid }
    }
    text = args
  }

  // The marker of a paste with no readable file is not user text: the length
  // checks do not count it.
  const typed = text.split(PASTE_MISSING_MARKER).join("").trim()

  // Rule 7 (checked here): text that is only internal tags is synthetic.
  if (typed === "" && hasMaTag(rawText, input.sb)) {
    return { eligible: false, rule: 7, reason: "synthetic-ma-only", sid }
  }

  // Rule 6: short prompt.
  if (codePointLength(typed) < config.minChars) {
    return { eligible: false, rule: 6, reason: "too-short", sid }
  }

  return { eligible: true, sid, text }
}

/** A simple command line: `/`, a name, white space, then the args. */
const SLASH_ARGS_RE = /^\/[A-Za-z0-9_:-]+\s+(\S[\s\S]*)$/

/**
 * The args of a simple slash command line (`/name args`), trimmed. The name
 * has only letters, digits, `-`, `_` and `:`. A line with no args, or with a
 * different first word (for example `/usr/bin/env x`), gives `undefined`.
 */
export function slashCommandArgs(text: string): string | undefined {
  const m = SLASH_ARGS_RE.exec(text)
  const args = m?.[1]?.trim() ?? ""
  return args === "" ? undefined : args
}

/**
 * The state while the handler works on a prompt, before a model call starts
 * (fork check, model choice). It sets `inFlight` and does not use an attempt.
 */
export function markBusy(state: TitleSessionState | undefined): TitleSessionState {
  const s = state ?? initialTitleState()
  return { ...s, inFlight: true }
}

/** The state after a prompt that made no call (no model): no attempt used. */
export function markIdle(state: TitleSessionState | undefined): TitleSessionState {
  const s = state ?? initialTitleState()
  return { ...s, inFlight: false }
}

/** Rule 9: the state after a call starts (`attempts++`, `inFlight`). */
export function startAttempt(state: TitleSessionState | undefined): TitleSessionState {
  const s = state ?? initialTitleState()
  return { ...s, attempts: s.attempts + 1, inFlight: true }
}

/**
 * The state after a title was written (or a title was found). It resets the
 * transient count and `retryAfter`.
 */
export function markSuccess(state: TitleSessionState | undefined): TitleSessionState {
  const { retryAfter: _r, ...s } = state ?? initialTitleState()
  return { ...s, inFlight: false, done: true, transientFailures: 0 }
}

/**
 * The state after a final failure: no write, and the attempt stays used. It
 * ends the row of transient failures. The next eligible prompt can retry
 * while `attempts` is below {@link MAX_ATTEMPTS}.
 */
export function markFailure(
  state: TitleSessionState | undefined,
  at: Date = new Date(),
): TitleSessionState {
  const { retryAfter: _r, ...s } = state ?? initialTitleState()
  return { ...s, inFlight: false, failedAt: at.toISOString(), transientFailures: 0 }
}

/**
 * The state after a transient failure: the attempt of this call is given
 * back, `transientFailures` gets 1 more, and `retryAfter` is `at` plus
 * {@link backoffMs}.
 */
export function markTransientFailure(
  state: TitleSessionState | undefined,
  at: Date = new Date(),
): TitleSessionState {
  const s = state ?? initialTitleState()
  const n = (s.transientFailures ?? 0) + 1
  return {
    ...s,
    attempts: Math.max(0, s.attempts - 1),
    inFlight: false,
    failedAt: at.toISOString(),
    transientFailures: n,
    retryAfter: at.getTime() + backoffMs(n),
  }
}
