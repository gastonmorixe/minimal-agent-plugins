/**
 * Tests of the retry policy: the failure classifier, the backoff table, and
 * the state changes of a transient failure.
 */

import { describe, expect, test } from "bun:test"

import { pluginSideband } from "../../tests/support/sideband.ts"

import { defaultTitleConfig } from "./config.ts"
import {
  checkEligibility,
  type EligibilityInput,
  initialTitleState,
  MAX_ATTEMPTS,
  markFailure,
  markSuccess,
  markTransientFailure,
  startAttempt,
  type TitleSessionState,
} from "./eligibility.ts"
import type { PromptSubmittedPayload, RunModeFact } from "./host-types.ts"
import { BACKOFF_TABLE_MS, backoffMs, classifyFailure, type FailureInput } from "./retry.ts"

const sb = await pluginSideband()
const SID = "ba0ad20f-0000-4000-8000-666ff6ccaa5b"
const REPL: RunModeFact = { mode: "repl", interactive: true }
const MIN = 60_000

function input(state: TitleSessionState | undefined, now: Date): EligibilityInput {
  const payload: PromptSubmittedPayload = {
    text: "write the design spec for a title plugin",
    cwd: "/tmp/x",
    sid: SID,
    exit: "submitted",
    queuePos: 0,
    source: "user",
  }
  return {
    payload,
    state,
    run: REPL,
    config: defaultTitleConfig(),
    env: { MINIMAL_AGENT_TITLE: "1" },
    sb,
    now,
  }
}

describe("classifyFailure: the real core values (llm-side.ts)", () => {
  const result = (stopReason: string, reason?: string, detail?: string): FailureInput => ({
    kind: "result",
    stopReason,
    ...(reason !== undefined ? { reason } : {}),
    ...(detail !== undefined ? { detail } : {}),
  })
  const cases: Array<[string, FailureInput, "transient" | "final"]> = [
    // abortResult(): stopReason = reason = "timeout" | "aborted".
    ["timeout", result("timeout", "timeout"), "transient"],
    ["aborted", result("aborted", "aborted"), "transient"],
    ["timeout stop with no reason", result("timeout"), "transient"],
    ["aborted stop with no reason", result("aborted"), "transient"],
    // reject("transport", ...): the detail is the thrown error text.
    ["transport ECONNRESET", result("error", "transport", "read ECONNRESET"), "transient"],
    ["transport socket hang up", result("error", "transport", "socket hang up"), "transient"],
    ["transport fetch failed", result("error", "transport", "fetch failed"), "transient"],
    ["transport DNS", result("error", "transport", "getaddrinfo EAI_AGAIN x"), "transient"],
    [
      "transport 529 overloaded",
      result("error", "transport", 'Anthropic API 529: {"type":"overloaded_error"}'),
      "transient",
    ],
    ["transport 503", result("error", "transport", "Generic endpoint 503: down"), "transient"],
    ["transport 500", result("error", "transport", "OpenAI API 500: oops"), "transient"],
    ["transport 429", result("error", "transport", "Anthropic API 429: slow down"), "transient"],
    ["transport 408", result("error", "transport", "Ollama Cloud API 408: late"), "transient"],
    [
      "transport stall (watchdog)",
      result("error", "transport", "no response body activity for 9.0s, aborting"),
      "transient",
    ],
    ["transport rate limit text", result("error", "transport", "rate_limit_error"), "transient"],
    [
      "transport 429 insufficient_quota (billing)",
      result("error", "transport", 'Anthropic API 429: {"code":"insufficient_quota"}'),
      "final",
    ],
    ["transport 400", result("error", "transport", "Anthropic API 400: bad request"), "final"],
    ["transport 401", result("error", "transport", "Anthropic API 401: auth"), "final"],
    ["transport 403", result("error", "transport", "Anthropic API 403: forbidden"), "final"],
    [
      "transport truncated stream",
      result("error", "transport", "stream ended without message_stop after 3.0s"),
      "final",
    ],
    ["transport unknown text", result("error", "transport", "something odd"), "final"],
    ["transport with no detail", result("error", "transport"), "final"],
    // reject(...) before the send: config or price, not the network.
    ["auth", result("error", "auth", "no credential"), "final"],
    ["auth over the network", result("error", "auth", "fetch failed"), "transient"],
    ["no-model", result("error", "no-model"), "final"],
    ["unknown-model", result("error", "unknown-model"), "final"],
    ["over-ceiling", result("error", "over-ceiling"), "final"],
    ["unknown-price", result("error", "unknown-price"), "final"],
    ["other-provider", result("error", "other-provider"), "final"],
    ["no-session-provider", result("error", "no-session-provider"), "final"],
    // The model gave a result that is not usable.
    ["invalid-json", result("end_turn", "invalid-json"), "final"],
    ["unusable title (end_turn, no reason)", result("end_turn"), "final"],
    ["max_tokens", result("max_tokens"), "final"],
    ["refusal", result("refusal"), "final"],
    ["content_filter", result("content_filter"), "final"],
    ["stop_sequence", result("stop_sequence"), "final"],
    ["pause_turn", result("pause_turn"), "final"],
    ["context_window_exceeded", result("context_window_exceeded"), "final"],
    ["tool_use", result("tool_use"), "final"],
    ["error with no reason", result("error"), "final"],
    ["unknown stop reason", result("weird_new_stop"), "final"],
    ["unknown reason", result("error", "weird-new-reason"), "final"],
    // setTitle threw (SessionMetaError codes).
    ["write not-owned", { kind: "write-failed", code: "not-owned" }, "final"],
    ["write no-session-file", { kind: "write-failed", code: "no-session-file" }, "final"],
    ["write unsafe", { kind: "write-failed", code: "unsafe" }, "final"],
    ["write write-failed", { kind: "write-failed", code: "write-failed" }, "final"],
    ["write with no code", { kind: "write-failed" }, "final"],
    // request() threw (core never throws: an old host or a bug).
    ["throw boom", { kind: "exception", error: new Error("boom") }, "final"],
    [
      "throw ECONNRESET code",
      { kind: "exception", error: Object.assign(new Error("x"), { code: "ECONNRESET" }) },
      "transient",
    ],
    [
      "throw AbortError",
      { kind: "exception", error: Object.assign(new Error("x"), { name: "AbortError" }) },
      "transient",
    ],
    [
      "throw errorClass transient",
      { kind: "exception", error: Object.assign(new Error("x"), { errorClass: "transient" }) },
      "transient",
    ],
    [
      "throw errorClass permanent",
      {
        kind: "exception",
        error: Object.assign(new Error("Anthropic API 503: x"), { errorClass: "permanent" }),
      },
      "final",
    ],
    ["throw a string", { kind: "exception", error: "socket hang up" }, "transient"],
    ["throw undefined", { kind: "exception", error: undefined }, "final"],
  ]
  for (const [name, inp, want] of cases) {
    test(`${name} -> ${want}`, () => {
      expect(classifyFailure(inp)).toBe(want)
    })
  }
})

describe("backoffMs: the table", () => {
  test("1, 2, 5, 15, 30 min, then 60 min for each later failure", () => {
    expect(BACKOFF_TABLE_MS).toEqual([1 * MIN, 2 * MIN, 5 * MIN, 15 * MIN, 30 * MIN, 60 * MIN])
    const got = [1, 2, 3, 4, 5, 6, 7, 8, 50].map((n) => backoffMs(n) / MIN)
    expect(got).toEqual([1, 2, 5, 15, 30, 60, 60, 60, 60])
  })

  test("a count below 1 or not finite gives the first step", () => {
    expect(backoffMs(0)).toBe(MIN)
    expect(backoffMs(-3)).toBe(MIN)
    expect(backoffMs(Number.NaN)).toBe(MIN)
  })
})

describe("state: a transient failure uses no attempt", () => {
  const T0 = new Date("2026-11-23T00:00:00Z")

  test("gives the attempt back, counts, and sets retryAfter", () => {
    const s = markTransientFailure(startAttempt(undefined), T0)
    expect(s).toMatchObject({
      attempts: 0,
      inFlight: false,
      transientFailures: 1,
      retryAfter: T0.getTime() + MIN,
      failedAt: T0.toISOString(),
    })
  })

  test("backoff rule: no call before retryAfter, a call at retryAfter", () => {
    const s = markTransientFailure(startAttempt(undefined), T0)
    const inside = checkEligibility(input(s, new Date(T0.getTime() + MIN - 1)))
    expect(inside).toMatchObject({ eligible: false, rule: 8, reason: "backoff" })
    expect(checkEligibility(input(s, new Date(T0.getTime() + MIN))).eligible).toBe(true)
  })

  test("max-attempts wins over backoff", () => {
    const s: TitleSessionState = {
      ...initialTitleState(),
      attempts: MAX_ATTEMPTS,
      retryAfter: T0.getTime() + MIN,
    }
    const r = checkEligibility(input(s, T0))
    expect(r.eligible ? "" : r.reason).toBe("max-attempts")
  })

  test("a final failure uses the attempt, ends the row and clears retryAfter", () => {
    let s = markTransientFailure(startAttempt(undefined), T0)
    s = markFailure(startAttempt(s), T0)
    expect(s).toMatchObject({ attempts: 1, transientFailures: 0 })
    expect(s.retryAfter).toBeUndefined()
  })

  test("a success resets the transient count and retryAfter", () => {
    const s = markSuccess(markTransientFailure(startAttempt(undefined), T0))
    expect(s).toMatchObject({ done: true, transientFailures: 0 })
    expect(s.retryAfter).toBeUndefined()
  })
})
