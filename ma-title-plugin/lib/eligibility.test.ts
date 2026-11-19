import { describe, expect, test } from "bun:test"

import { defaultTitleConfig, type TitleConfig } from "./config.ts"
import {
  checkEligibility,
  type EligibilityInput,
  initialTitleState,
  isSubagentRun,
  MAX_ATTEMPTS,
  markFailure,
  markSuccess,
  resolveModeGate,
  startAttempt,
  type TitleSessionState,
} from "./eligibility.ts"
import type { PromptSubmittedPayload, RunModeFact, SessionTitleState } from "./host-types.ts"

const SID = "11111111-2222-3333-4444-555555555555"
const REPL: RunModeFact = { mode: "repl", interactive: true }
const ON = { MINIMAL_AGENT_TITLE: "1" }

function payload(over: Partial<PromptSubmittedPayload> = {}): PromptSubmittedPayload {
  return {
    text: "write the design spec for a title plugin",
    cwd: "/tmp/x",
    sid: SID,
    exit: "submitted",
    queuePos: 0,
    source: "user",
    ...over,
  }
}

function input(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    payload: payload(),
    run: REPL,
    config: defaultTitleConfig(),
    env: { ...ON },
    ...over,
  }
}

function aiTitle(title: string): SessionTitleState {
  return { ai: { kind: "title", v: 1, sid: SID, title, source: "ai", at: "2026-11-19T00:00:00Z" } }
}

describe("checkEligibility: rules 1-9 (table)", () => {
  const cases: Array<[string, Partial<EligibilityInput>, number, string]> = [
    [
      "rule 1: default OFF in one-shot (no env, no config)",
      { env: {}, run: { mode: "one-shot", interactive: false } },
      1,
      "mode:default-off",
    ],
    ["rule 1: no run fact (old host)", { run: undefined }, 1, "mode:no-run-fact"],
    ["rule 1: dry run", { run: { ...REPL, dryRun: true } }, 1, "mode:dry-run"],
    ["rule 1: kill switch", { env: { MINIMAL_AGENT_TITLE: "0" } }, 1, "mode:kill-switch"],
    [
      "rule 1: plugin disabled in config",
      { config: { ...defaultTitleConfig(), enabled: false } },
      1,
      "mode:plugin-disabled",
    ],
    ["rule 2: no sid", { payload: payload({ sid: null }) }, 2, "no-sid"],
    ["rule 2: canceled prompt", { payload: payload({ exit: "canceled" }) }, 2, "canceled"],
    ["rule 2: scoped sid differs", { ctxSid: "other-sid" }, 2, "session-mismatch"],
    ["rule 3: done", { state: { ...initialTitleState(), done: true } }, 3, "done"],
    [
      "rule 3: in flight",
      { state: { ...initialTitleState(), attempts: 1, inFlight: true } },
      3,
      "in-flight",
    ],
    ["rule 4: resume with an ai title", { titleState: aiTitle("Old title") }, 4, "has-title"],
    [
      "rule 4: user title",
      {
        titleState: {
          user: { kind: "title", v: 1, sid: SID, title: "Mine", source: "user", at: "x" },
        },
      },
      4,
      "has-title",
    ],
    [
      "rule 5: slash command",
      { payload: payload({ text: "/sessions list all" }) },
      5,
      "slash-command",
    ],
    [
      "rule 5: slash after a ma tag",
      { payload: payload({ text: "<ma::x>y</ma::x>  /compact now please" }) },
      5,
      "slash-command",
    ],
    ["rule 6: short prompt", { payload: payload({ text: "hi" }) }, 6, "too-short"],
    ["rule 6: 9 chars", { payload: payload({ text: "123456789" }) }, 6, "too-short"],
    [
      "rule 7: only ma tags",
      {
        payload: payload({ text: "<ma::agent::policy>long policy text here</ma::agent::policy>" }),
      },
      7,
      "synthetic-ma-only",
    ],
    ["rule 7: source expand", { payload: payload({ source: "expand" }) }, 7, "source-not-user"],
    ["rule 7: source command", { payload: payload({ source: "command" }) }, 7, "source-not-user"],
    ["rule 7: source recovery", { payload: payload({ source: "recovery" }) }, 7, "source-not-user"],
    ["rule 7: source continue", { payload: payload({ source: "continue" }) }, 7, "source-not-user"],
    [
      "rule 7: source missing (old core)",
      { payload: payload({ source: undefined }) },
      7,
      "source-not-user",
    ],
    [
      "rule 8: max attempts",
      { state: { ...initialTitleState(), attempts: MAX_ATTEMPTS } },
      8,
      "max-attempts",
    ],
  ]
  for (const [name, over, rule, reason] of cases) {
    test(name, () => {
      const r = checkEligibility(input(over))
      expect(r.eligible).toBe(false)
      if (!r.eligible) {
        expect(r.rule).toBe(rule)
        expect(r.reason as string).toBe(reason)
      }
    })
  }

  test("rule 9: eligible gives the captured sid and the clean text", () => {
    const r = checkEligibility(
      input({ payload: payload({ text: "  fix the <ma::x>y</ma::x>login bug\n\n\n\nnow " }) }),
    )
    expect(r).toEqual({ eligible: true, sid: SID, text: "fix the login bug\n\nnow" })
  })

  test("10 chars is eligible", () => {
    expect(checkEligibility(input({ payload: payload({ text: "1234567890" }) })).eligible).toBe(
      true,
    )
  })

  test("minChars from config", () => {
    const config: TitleConfig = { ...defaultTitleConfig(), minChars: 3 }
    expect(checkEligibility(input({ config, payload: payload({ text: "hey" }) })).eligible).toBe(
      true,
    )
  })

  test("same scoped sid is eligible", () => {
    expect(checkEligibility(input({ ctxSid: SID })).eligible).toBe(true)
  })

  test("rule 4 asks the caller to set done", () => {
    const r = checkEligibility(input({ titleState: aiTitle("Old title") }))
    expect(r.eligible).toBe(false)
    if (!r.eligible) expect(r.markDone).toBe(true)
  })

  test("an empty user title line is not a title", () => {
    const titleState: SessionTitleState = {
      user: { kind: "title", v: 1, sid: SID, title: "", source: "user", at: "x" },
    }
    expect(checkEligibility(input({ titleState })).eligible).toBe(true)
  })

  test("skipped prompts do not use the attempt (pure check)", () => {
    const state = initialTitleState()
    checkEligibility(input({ state, payload: payload({ text: "hi" }) }))
    checkEligibility(input({ state, payload: payload({ source: "expand" }) }))
    expect(state.attempts).toBe(0)
  })
})

describe("attempt flow: 1 try + 1 retry", () => {
  test("fail, retry, fail, then stop", () => {
    let state: TitleSessionState | undefined
    // First prompt: start.
    expect(checkEligibility(input({ state })).eligible).toBe(true)
    state = startAttempt(state)
    expect(state).toMatchObject({ attempts: 1, inFlight: true })
    // A prompt while the call runs: in-flight guard.
    const busy = checkEligibility(input({ state }))
    expect(busy.eligible ? "" : busy.reason).toBe("in-flight")
    // Failure: retry allowed.
    state = markFailure(state, new Date("2026-11-19T00:00:00Z"))
    expect(state).toMatchObject({
      attempts: 1,
      inFlight: false,
      failedAt: "2026-11-19T00:00:00.000Z",
    })
    expect(checkEligibility(input({ state })).eligible).toBe(true)
    state = startAttempt(state)
    state = markFailure(state)
    // No 3rd call.
    const r = checkEligibility(input({ state }))
    expect(r.eligible ? "" : r.reason).toBe("max-attempts")
  })

  test("success sets done; no more calls", () => {
    const state = markSuccess(startAttempt(undefined))
    expect(state).toMatchObject({ attempts: 1, inFlight: false, done: true })
    const r = checkEligibility(input({ state }))
    expect(r.eligible ? "" : r.reason).toBe("done")
  })
})

describe("resolveModeGate: run modes (SPEC §7.1, §7.3)", () => {
  const cfg = defaultTitleConfig()
  const gate = (run: RunModeFact | undefined, env: NodeJS.ProcessEnv, config = cfg) =>
    resolveModeGate({ run, env, config })

  test("P1b default: ON in the interactive repl (no env, no config)", () => {
    expect(gate(REPL, {})).toEqual({ allowed: true, reason: "default-on" })
    expect(checkEligibility(input({ env: {} })).eligible).toBe(true)
  })

  test("P1b default: OFF in a repl that is not interactive", () => {
    expect(gate({ mode: "repl", interactive: false }, {})).toEqual({
      allowed: false,
      reason: "default-off",
    })
  })

  test("P1b default: OFF in one-shot, stream-json, host", () => {
    for (const mode of ["one-shot", "stream-json", "host"] as const) {
      for (const interactive of [false, true]) {
        expect(gate({ mode, interactive }, {})).toEqual({ allowed: false, reason: "default-off" })
      }
    }
  })

  test("P1b default: OFF in subagent (no env, no config)", () => {
    expect(gate({ mode: "subagent", interactive: false }, {})).toEqual({
      allowed: false,
      reason: "subagent-off",
    })
  })

  test("MINIMAL_AGENT_TITLE=0 turns the default repl OFF", () => {
    expect(gate(REPL, { MINIMAL_AGENT_TITLE: "0" })).toEqual({
      allowed: false,
      reason: "kill-switch",
    })
  })

  test("config enabled:false turns the default repl OFF", () => {
    expect(gate(REPL, {}, { ...cfg, enabled: false })).toEqual({
      allowed: false,
      reason: "plugin-disabled",
    })
  })

  test("config modes override the default: [] turns the repl OFF", () => {
    expect(gate(REPL, {}, { ...cfg, modes: [] })).toEqual({
      allowed: false,
      reason: "not-in-config-modes",
    })
  })

  test("config modes override the default: [one-shot] turns one-shot ON", () => {
    const config = { ...cfg, modes: ["one-shot" as const] }
    expect(gate({ mode: "one-shot", interactive: false }, {}, config).allowed).toBe(true)
    expect(gate(REPL, {}, config).allowed).toBe(false)
  })

  test("MINIMAL_AGENT_TITLE=1 allows repl, one-shot, stream-json, host", () => {
    for (const mode of ["repl", "one-shot", "stream-json", "host"] as const) {
      expect(gate({ mode, interactive: false }, ON)).toEqual({ allowed: true, reason: "forced-on" })
    }
  })

  test("config modes: only listed modes", () => {
    const config = { ...cfg, modes: ["repl" as const] }
    expect(gate(REPL, {}, config)).toEqual({ allowed: true, reason: "config-modes" })
    expect(gate({ mode: "one-shot", interactive: false }, {}, config)).toEqual({
      allowed: false,
      reason: "not-in-config-modes",
    })
  })

  test("kill switch wins over config modes", () => {
    const config = { ...cfg, modes: ["repl" as const] }
    expect(gate(REPL, { MINIMAL_AGENT_TITLE: "0" }, config).reason).toBe("kill-switch")
  })

  test("args win over env: --no-title with MINIMAL_AGENT_TITLE=1", () => {
    expect(
      resolveModeGate({ run: REPL, env: ON, config: cfg, args: { title: false } }).reason,
    ).toBe("kill-switch")
    expect(
      resolveModeGate({
        run: REPL,
        env: { MINIMAL_AGENT_TITLE: "0" },
        config: cfg,
        args: { title: true },
      }).allowed,
    ).toBe(true)
  })

  test("dry run wins over MINIMAL_AGENT_TITLE=1", () => {
    expect(gate({ ...REPL, dryRun: true }, ON).reason).toBe("dry-run")
  })

  test("other MINIMAL_AGENT_TITLE values are ignored", () => {
    expect(gate(REPL, { MINIMAL_AGENT_TITLE: "yes" }).reason).toBe("default-on")
    expect(
      gate({ mode: "one-shot", interactive: false }, { MINIMAL_AGENT_TITLE: "yes" }).reason,
    ).toBe("default-off")
  })
})

describe("sub-agent policy (SPEC §7.4, IMPL-PLAN R8)", () => {
  const cfg = defaultTitleConfig()
  const worker: RunModeFact = {
    mode: "subagent",
    interactive: false,
    subagent: { id: "A1", role: "worker", leadSid: "lead" },
  }

  test("worker with inherited MINIMAL_AGENT_TITLE=1 is OFF", () => {
    expect(resolveModeGate({ run: worker, env: ON, config: cfg })).toEqual({
      allowed: false,
      reason: "subagent-off",
    })
    const r = checkEligibility(input({ run: worker, env: ON }))
    expect(r.eligible ? "" : r.reason).toBe("mode:subagent-off")
  })

  test("worker env id wins over a stream-json run fact", () => {
    const run: RunModeFact = { mode: "stream-json", interactive: false }
    const env = { ...ON, MINIMAL_AGENT_SUBAGENT_ID: "A2" }
    expect(resolveModeGate({ run, env, config: cfg }).reason).toBe("subagent-off")
  })

  test("worker env sid (MINIMAL_AGENT_SUBAGENT_SID) also marks a sub-agent", () => {
    const run: RunModeFact = { mode: "stream-json", interactive: false }
    const env = { ...ON, MINIMAL_AGENT_SUBAGENT_SID: "sid-A2" }
    expect(isSubagentRun(run, env)).toBe(true)
    expect(isSubagentRun(run, { MINIMAL_AGENT_SUBAGENT_SID: "  " })).toBe(false)
    expect(resolveModeGate({ run, env, config: cfg }).reason).toBe("subagent-off")
  })

  test("worker with config modes [subagent] but subagents off is OFF", () => {
    const config = { ...cfg, modes: ["subagent" as const] }
    expect(resolveModeGate({ run: worker, env: {}, config }).reason).toBe("subagent-off")
  })

  test("subagents derived: no model call", () => {
    const config = { ...cfg, subagents: "derived" as const }
    expect(resolveModeGate({ run: worker, env: ON, config }).reason).toBe("subagent-derived")
  })

  test("subagents model: needs an opt-in", () => {
    const config = { ...cfg, subagents: "model" as const }
    expect(resolveModeGate({ run: worker, env: {}, config }).allowed).toBe(false)
    expect(resolveModeGate({ run: worker, env: ON, config }).reason).toBe("subagent-allowed")
    expect(
      resolveModeGate({ run: worker, env: {}, config: { ...config, modes: ["subagent"] } }).allowed,
    ).toBe(true)
  })
})
