/**
 * Integration tests of the title handler with a fake host (no network, no
 * real home: `MINIMAL_AGENT_HOME` is a temp dir in each env).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type {
  EventHandlerContext,
  LlmSideRequest,
  LlmSideResult,
  ModelsReadApi,
  ModelView,
  PromptSubmittedPayload,
  ResolvedUtilityModel,
  RunModeFact,
  SessionTitleInput,
  SessionTitleState,
  TitleHost,
} from "../lib/host-types.ts"
import { selectTitleModel } from "../lib/model-select.ts"

import {
  createTitleHandler,
  SYSTEM_PROMPT,
  TITLE_ATTEMPT_EVENT,
  TITLE_MAX_TOKENS,
  TITLE_SCHEMA,
  type TitleAttemptEvent,
} from "./on_prompt_submitted.ts"

const SID = "ba0ad20f-0000-4000-8000-666ff6ccaa5b"
const REPL: RunModeFact = { mode: "repl", interactive: true, providerId: "prov" }

function model(id: string, inputUSD: number, tags: string[], structured = true): ModelView {
  return {
    id,
    providerId: "prov",
    tags,
    capabilities: { structuredOutputs: structured },
    pricing: { inputUSD, outputUSD: inputUSD * 5 },
  }
}

const CHEAP = model("cheap-1", 0.1, ["utility", "haiku"])
const MAIN = model("main-1", 5, ["opus", "flagship"])

interface FakeHost {
  host: TitleHost
  requests: LlmSideRequest[]
  writes: SessionTitleInput[]
  titleState: SessionTitleState
  respond: (req: LlmSideRequest) => Promise<LlmSideResult>
}

function okResult(title = "Title plugin spec"): LlmSideResult {
  return {
    text: JSON.stringify({ title }),
    json: { title },
    stopReason: "end_turn",
    model: "cheap-1",
    provider: "prov",
    usage: { inputTokens: 812, outputTokens: 9 },
    costUsd: 0.0001,
    latencyMs: 420,
  }
}

function makeHost(
  opts: { models?: ModelView[]; utility?: ResolvedUtilityModel | null } = {},
): FakeHost {
  const list = opts.models ?? [CHEAP, MAIN]
  const fake: FakeHost = {
    requests: [],
    writes: [],
    titleState: {},
    respond: async () => okResult(),
    host: undefined as unknown as TitleHost,
  }
  const utility =
    opts.utility === null
      ? undefined
      : (opts.utility ?? {
          modelId: "cheap-1",
          providerId: "prov",
          structured: "json_schema" as const,
          thinkingOff: true,
          effort: "low" as const,
          stream: "off" as const,
          pricing: CHEAP.pricing,
        })
  fake.host = {
    llm: {
      request: (req) => {
        fake.requests.push(req)
        return fake.respond(req)
      },
    },
    sessionMeta: {
      getTitle: (sid) => (sid === SID ? fake.titleState : {}),
      setTitle: async (input) => {
        fake.writes.push(input)
      },
    },
    models: {
      find: (id) => list.find((m) => m.id === id),
      findForProvider: (id, p) => list.find((m) => m.id === id && m.providerId === p),
      list: () => list,
      findByTags: (p, tags) =>
        list.find((m) => m.providerId === p && tags.every((t) => (m.tags ?? []).includes(t))),
      utilityFor: () => utility,
    },
  }
  return fake
}

let home: string
let baseEnv: Record<string, string>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ma-title-t2-"))
  baseEnv = { MINIMAL_AGENT_HOME: join(home, ".minimal-agent"), MINIMAL_AGENT_TITLE: "1" }
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

interface CtxOpts {
  text?: string
  source?: PromptSubmittedPayload["source"]
  sid?: string | null
  run?: RunModeFact | undefined
  env?: Record<string, string>
  host?: TitleHost | undefined
}

function makeCtx(
  fake: FakeHost | undefined,
  o: CtxOpts = {},
): { ctx: EventHandlerContext; events: TitleAttemptEvent[]; logs: string[] } {
  const events: TitleAttemptEvent[] = []
  const logs: string[] = []
  const payload: PromptSubmittedPayload = {
    text: o.text ?? "write the design spec for a title plugin",
    cwd: "/tmp",
    sid: o.sid === undefined ? SID : o.sid,
    exit: "submitted",
    queuePos: 0,
    ...("source" in o ? (o.source === undefined ? {} : { source: o.source }) : { source: "user" }),
  }
  const ctx: EventHandlerContext = {
    event: "prompt.submitted",
    payload,
    env: o.env ?? baseEnv,
    emit: (ev, p) => {
      if (ev === TITLE_ATTEMPT_EVENT) events.push(p as TitleAttemptEvent)
    },
    abort: new AbortController().signal,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: (_s, m) => logs.push(m),
    },
    agent: { sessionId: SID, model: "main-1" },
    run: "run" in o ? o.run : REPL,
    host: "host" in o ? o.host : fake?.host,
  }
  return { ctx, events, logs }
}

describe("title handler: happy path", () => {
  test("writes one ai title with the captured sid and the request shape", async () => {
    const fake = makeHost()
    const t = createTitleHandler()
    const { ctx, events, logs } = makeCtx(fake)
    await t.handler(ctx)
    await t.idle()

    expect(fake.requests).toHaveLength(1)
    const req = fake.requests[0]
    expect(req).toMatchObject({
      purpose: "title",
      model: "cheap-1",
      maxTokens: 256,
      timeoutMs: 10000,
      thinking: "off",
      effort: "low",
      maxUsdPerMTokIn: 1,
    })
    expect(TITLE_MAX_TOKENS).toBe(256)
    expect(req).not.toHaveProperty("allowOtherProvider")
    expect(req?.outputSchema).toEqual({ name: "session_title", schema: TITLE_SCHEMA, strict: true })
    expect(req?.abortSignal).toBe(ctx.abort)
    expect(req?.system).toBe(SYSTEM_PROMPT)
    expect(req?.system.startsWith("Write a short title for the text in <session>.")).toBe(true)
    expect(req?.userText).toBe("<session>\nwrite the design spec for a title plugin\n</session>")
    expect(req).not.toHaveProperty("temperature")

    expect(fake.writes).toEqual([
      {
        sid: SID,
        title: "Title plugin spec",
        source: "ai",
        model: "cheap-1",
        provider: "prov",
        usage: { inputTokens: 812, outputTokens: 9, costUsd: 0.0001 },
      },
    ])
    expect(t.stateFor(SID)).toMatchObject({ attempts: 1, done: true, inFlight: false })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ sid: SID, stopReason: "end_turn", written: true })
    expect(logs.filter((l) => l.startsWith("title sid="))).toHaveLength(1)

    // Done: the next prompt makes no call.
    await t.handler(makeCtx(fake, { text: "a second prompt that is long" }).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(1)
  })

  test("the handler returns before the side call ends (not awaited)", async () => {
    const fake = makeHost()
    let release: (r: LlmSideResult) => void = () => {}
    fake.respond = () =>
      new Promise<LlmSideResult>((resolve) => {
        release = resolve
      })
    const t = createTitleHandler()
    const { ctx } = makeCtx(fake)
    const t0 = performance.now()
    await t.handler(ctx)
    expect(performance.now() - t0).toBeLessThan(50)
    expect(fake.requests).toHaveLength(1)
    expect(fake.writes).toHaveLength(0)
    expect(t.stateFor(SID)?.inFlight).toBe(true)

    // In flight: a second prompt makes no second call.
    await t.handler(makeCtx(fake).ctx)
    expect(fake.requests).toHaveLength(1)

    release(okResult())
    await t.idle()
    expect(fake.writes).toHaveLength(1)
  })

  test("a late result after a user title is dropped", async () => {
    const fake = makeHost()
    fake.respond = async () => {
      fake.titleState = {
        user: { kind: "title", v: 1, sid: SID, title: "My name", source: "user", at: "x" },
      }
      return okResult()
    }
    const t = createTitleHandler()
    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(1)
    expect(fake.writes).toHaveLength(0)
    expect(t.stateFor(SID)?.done).toBe(true)
  })
})

describe("title handler: gates (no call)", () => {
  test("default OFF: no MINIMAL_AGENT_TITLE and no config modes", async () => {
    const fake = makeHost()
    const t = createTitleHandler()
    const env = { MINIMAL_AGENT_HOME: baseEnv.MINIMAL_AGENT_HOME as string }
    await t.handler(makeCtx(fake, { env }).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(0)
    expect(fake.writes).toHaveLength(0)
    expect(t.stateFor(SID)).toBeUndefined()
  })

  test("config plugins.title.modes includes the mode → on", async () => {
    const dir = baseEnv.MINIMAL_AGENT_HOME as string
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "config.jsonc"), '{ "plugins": { "title": { "modes": ["repl"] } } }')
    const fake = makeHost()
    const t = createTitleHandler()
    await t.handler(makeCtx(fake, { env: { MINIMAL_AGENT_HOME: dir } }).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(1)
    expect(fake.writes).toHaveLength(1)
  })

  test("kill switch MINIMAL_AGENT_TITLE=0 → off", async () => {
    const fake = makeHost()
    const t = createTitleHandler()
    await t.handler(makeCtx(fake, { env: { ...baseEnv, MINIMAL_AGENT_TITLE: "0" } }).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(0)
  })

  test("non-user source is ignored and does not use the attempt", async () => {
    const fake = makeHost()
    const t = createTitleHandler()
    for (const source of ["expand", "command", "recovery", "continue", undefined] as const) {
      await t.handler(makeCtx(fake, { source }).ctx)
    }
    await t.idle()
    expect(fake.requests).toHaveLength(0)
    expect(t.stateFor(SID)).toBeUndefined()
    // A typed prompt after them still gets the title.
    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    expect(fake.writes).toHaveLength(1)
  })

  test("slash command and short prompt do not use the attempt", async () => {
    const fake = makeHost()
    const t = createTitleHandler()
    await t.handler(makeCtx(fake, { text: "/model haiku please now" }).ctx)
    await t.handler(makeCtx(fake, { text: "hi" }).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(0)
    expect(t.stateFor(SID)).toBeUndefined()
  })

  test("sub-agent run mode: never, also with MINIMAL_AGENT_TITLE=1", async () => {
    const fake = makeHost()
    const t = createTitleHandler()
    const run: RunModeFact = { mode: "subagent", interactive: false, subagent: { id: "A1" } }
    await t.handler(makeCtx(fake, { run }).ctx)
    // Env only (the run fact says stream-json).
    const env = { ...baseEnv, MINIMAL_AGENT_SUBAGENT_ID: "A1" }
    await t.handler(makeCtx(fake, { run: { mode: "stream-json", interactive: false }, env }).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(0)
  })

  test("dry run, no run fact, no sid → no call", async () => {
    const fake = makeHost()
    const t = createTitleHandler()
    await t.handler(makeCtx(fake, { run: { ...REPL, dryRun: true } }).ctx)
    await t.handler(makeCtx(fake, { run: undefined }).ctx)
    await t.handler(makeCtx(fake, { sid: null }).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(0)
  })

  test("no host (no `host: true` or old core) → no call, no throw", async () => {
    const t = createTitleHandler()
    const { ctx, logs } = makeCtx(undefined, { host: undefined })
    await t.handler(ctx)
    await t.idle()
    expect(logs.some((l) => l.includes("host has no llm.request"))).toBe(true)
  })

  test("user title exists → no call, state done", async () => {
    const fake = makeHost()
    fake.titleState = {
      user: { kind: "title", v: 1, sid: SID, title: "Mine", source: "user", at: "x" },
    }
    const t = createTitleHandler()
    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(0)
    expect(t.stateFor(SID)?.done).toBe(true)
  })

  test("an empty user line (cleared) is not a title → call", async () => {
    const fake = makeHost()
    fake.titleState = {
      user: { kind: "title", v: 1, sid: SID, title: "", source: "user", at: "x" },
    }
    const t = createTitleHandler()
    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(1)
  })
})

describe("title handler: failure and retry", () => {
  const failures: Array<[string, () => LlmSideResult]> = [
    ["timeout", () => ({ ...okResult(), json: undefined, text: "", stopReason: "timeout" })],
    ["invalid json", () => ({ ...okResult(), json: undefined, text: "{not json" })],
    ["max_tokens", () => ({ ...okResult(), stopReason: "max_tokens" })],
    ["error", () => ({ ...okResult(), json: undefined, text: "", stopReason: "error" })],
    ["unusable title", () => ({ ...okResult(), json: { title: "" } })],
  ]
  for (const [name, make] of failures) {
    test(`${name}: no title, one retry on the next prompt, then stop`, async () => {
      const fake = makeHost()
      fake.respond = async () => make()
      const t = createTitleHandler()
      const first = makeCtx(fake)
      await t.handler(first.ctx)
      await t.idle()
      expect(fake.requests).toHaveLength(1)
      expect(fake.writes).toHaveLength(0)
      expect(t.stateFor(SID)).toMatchObject({ attempts: 1, inFlight: false, done: false })
      expect(first.events).toHaveLength(1)
      expect(first.events[0]?.written).toBe(false)

      await t.handler(makeCtx(fake).ctx)
      await t.idle()
      expect(fake.requests).toHaveLength(2)

      await t.handler(makeCtx(fake).ctx)
      await t.handler(makeCtx(fake).ctx)
      await t.idle()
      expect(fake.requests).toHaveLength(2)
      expect(fake.writes).toHaveLength(0)
    })
  }

  test("a throwing request is silent and counts as a failure", async () => {
    const fake = makeHost()
    fake.respond = async () => {
      throw new Error("boom")
    }
    const t = createTitleHandler()
    const { ctx, events, logs } = makeCtx(fake)
    await t.handler(ctx)
    await t.idle()
    expect(events[0]?.stopReason).toBe("exception")
    expect(logs.some((l) => l.includes("boom"))).toBe(true)
    expect(t.stateFor(SID)?.inFlight).toBe(false)
  })

  test("a throwing setTitle gives write-failed, then one retry, then stop", async () => {
    const fake = makeHost()
    let throws = 0
    fake.host = {
      ...fake.host,
      sessionMeta: {
        getTitle: () => ({}),
        setTitle: async () => {
          throws++
          throw Object.assign(new Error("cannot write"), { code: "write-failed" })
        },
      },
    }
    const t = createTitleHandler()
    const first = makeCtx(fake)
    await t.handler(first.ctx)
    await t.idle()
    expect(throws).toBe(1)
    expect(first.events).toHaveLength(1)
    expect(first.events[0]).toMatchObject({ stopReason: "write-failed", written: false })
    expect(first.events[0]?.latencyMs).toBe(420)
    expect(first.logs.some((l) => l.includes("write-failed code=write-failed"))).toBe(true)
    expect(t.stateFor(SID)).toMatchObject({ attempts: 1, inFlight: false, done: false })

    // One retry on the next eligible prompt.
    const second = makeCtx(fake)
    await t.handler(second.ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(2)
    expect(throws).toBe(2)
    expect(second.events[0]?.stopReason).toBe("write-failed")

    // Then stop at MAX_ATTEMPTS.
    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(2)
    expect(t.stateFor(SID)).toMatchObject({ attempts: 2, done: false })
  })

  test("in-flight guard: two prompts during one slow call make one call and one event", async () => {
    const fake = makeHost()
    let release: (r: LlmSideResult) => void = () => {}
    fake.respond = () =>
      new Promise<LlmSideResult>((resolve) => {
        release = resolve
      })
    const t = createTitleHandler()
    const first = makeCtx(fake)
    const second = makeCtx(fake, { text: "a second prompt that is long enough" })
    const third = makeCtx(fake, { text: "a third prompt that is long enough" })
    await t.handler(first.ctx)
    await t.handler(second.ctx)
    await t.handler(third.ctx)
    expect(fake.requests).toHaveLength(1)
    expect(t.stateFor(SID)).toMatchObject({ attempts: 1, inFlight: true, done: false })
    expect(second.logs.some((l) => l.includes("rule=3 in-flight"))).toBe(true)
    expect(third.logs.some((l) => l.includes("rule=3 in-flight"))).toBe(true)

    release(okResult())
    await t.idle()
    expect(fake.writes).toHaveLength(1)
    expect(first.events).toHaveLength(1)
    expect(second.events).toHaveLength(0)
    expect(third.events).toHaveLength(0)
    expect(t.stateFor(SID)).toMatchObject({ attempts: 1, inFlight: false, done: true })
  })

  test("a failure then a success on the retry writes the title", async () => {
    const fake = makeHost()
    let n = 0
    fake.respond = async () => (++n === 1 ? { ...okResult(), stopReason: "timeout" } : okResult())
    const t = createTitleHandler()
    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(2)
    expect(fake.writes).toHaveLength(1)
  })

  test("text JSON is parsed when the host gives no json field", async () => {
    const fake = makeHost()
    fake.respond = async () => ({ ...okResult("Parsed from text"), json: undefined })
    const t = createTitleHandler()
    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    expect(fake.writes[0]?.title).toBe("Parsed from text")
  })
})

describe("title handler: model choice", () => {
  test("no title profile → no call, no-model diagnostics (tagged models are not used)", async () => {
    const fake = makeHost({ models: [CHEAP, MAIN], utility: null })
    const t = createTitleHandler()
    const { ctx, events } = makeCtx(fake)
    await t.handler(ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(0)
    expect(events).toEqual([
      expect.objectContaining({ sid: SID, stopReason: "no-model", written: false }),
    ])
  })

  test("utility model over the price ceiling → no call, over-ceiling", async () => {
    const pricey = model("pricey-1", 1.25, ["utility"])
    const fake = makeHost({
      models: [pricey, MAIN],
      utility: {
        modelId: "pricey-1",
        providerId: "prov",
        structured: "json_schema",
        pricing: pricey.pricing,
      },
    })
    const t = createTitleHandler()
    const { ctx, events } = makeCtx(fake)
    await t.handler(ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(0)
    expect(events[0]?.stopReason).toBe("over-ceiling")
  })
})

describe("title handler: effort", () => {
  test("the effort comes from the profile", async () => {
    const fake = makeHost({
      utility: {
        modelId: "cheap-1",
        providerId: "prov",
        structured: "json_schema",
        effort: "medium",
        pricing: CHEAP.pricing,
      },
    })
    const t = createTitleHandler()
    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    expect(fake.requests[0]?.effort).toBe("medium")
  })

  test("a profile with no effort sends no effort", async () => {
    const fake = makeHost({
      utility: {
        modelId: "cheap-1",
        providerId: "prov",
        structured: "json_schema",
        pricing: CHEAP.pricing,
      },
    })
    const t = createTitleHandler()
    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]).not.toHaveProperty("effort")
  })

  test("config plugins.title.effort replaces the profile effort", async () => {
    const dir = baseEnv.MINIMAL_AGENT_HOME as string
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "config.jsonc"), '{ "plugins": { "title": { "effort": "high" } } }')
    const fake = makeHost()
    const t = createTitleHandler()
    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    expect(fake.requests[0]?.effort).toBe("high")
  })
})

describe("selectTitleModel", () => {
  const base = { sessionProviderId: "prov", maxUsdPerMTokIn: 1 }
  const profile = (over: Partial<ResolvedUtilityModel> = {}): ResolvedUtilityModel => ({
    modelId: "cheap-1",
    providerId: "prov",
    structured: "json_schema",
    effort: "low",
    stream: "off",
    pricing: CHEAP.pricing,
    ...over,
  })
  const view = (list: ModelView[], utility?: ResolvedUtilityModel) =>
    makeHost({ models: list, utility: utility ?? null }).host.models
  const hostModels = (): ModelsReadApi => {
    const m = makeHost().host.models
    if (!m) throw new Error("fake host has no models")
    return m
  }

  test("the provider profile wins and gives its effort", () => {
    const r = selectTitleModel({ ...base, models: makeHost().host.models })
    expect(r).toMatchObject({ ok: true, modelId: "cheap-1", step: "profile", effort: "low" })
  })

  test("no profile → no-model, also when models have the utility or haiku tag", () => {
    const tagged = [model("u-1", 0.1, ["utility"]), model("h-1", 0.1, ["haiku"])]
    expect(selectTitleModel({ ...base, models: view(tagged) })).toMatchObject({
      ok: false,
      reason: "no-model",
    })
  })

  test("no profile → the override is not used", () => {
    expect(selectTitleModel({ ...base, models: view([CHEAP]), override: "cheap-1" })).toMatchObject(
      { ok: false, reason: "no-model" },
    )
  })

  test("an older host with no utilityFor → no-model", () => {
    const models: ModelsReadApi = { ...hostModels(), utilityFor: undefined }
    expect(selectTitleModel({ ...base, models })).toMatchObject({ ok: false, reason: "no-model" })
  })

  test("a profile with structured none → no-model", () => {
    const r = selectTitleModel({ ...base, models: view([CHEAP], profile({ structured: "none" })) })
    expect(r).toMatchObject({ ok: false, reason: "no-model" })
  })

  test("a profile of another provider → no-model", () => {
    const r = selectTitleModel({ ...base, models: view([], profile({ providerId: "other" })) })
    expect(r).toMatchObject({ ok: false, reason: "no-model" })
  })

  test("profile price: unknown fails, over the ceiling fails, $0 passes", () => {
    const nan = { inputUSD: Number.NaN, outputUSD: 0 }
    expect(
      selectTitleModel({ ...base, models: view([], profile({ pricing: nan })) }),
    ).toMatchObject({ ok: false, reason: "over-ceiling" })
    expect(
      selectTitleModel({
        ...base,
        models: view([], profile({ pricing: { inputUSD: 1.25, outputUSD: 6 } })),
      }),
    ).toMatchObject({ ok: false, reason: "over-ceiling" })
    expect(
      selectTitleModel({
        ...base,
        models: view([], profile({ pricing: { inputUSD: 0, outputUSD: 0 } })),
      }),
    ).toMatchObject({ ok: true, step: "profile" })
  })

  test("the override of the same provider wins and keeps the profile effort", () => {
    const other = model("other-cheap", 0.2, [])
    const r = selectTitleModel({
      ...base,
      models: view([CHEAP, other], profile()),
      override: "other-cheap",
    })
    expect(r).toMatchObject({ ok: true, modelId: "other-cheap", step: "override", effort: "low" })
  })

  test("the override of another provider stops the choice", () => {
    const other: ModelView = { ...model("other-1", 0.1, []), providerId: "other" }
    const r = selectTitleModel({
      ...base,
      models: view([CHEAP, other], profile()),
      override: "other-1",
    })
    expect(r).toMatchObject({ ok: false, reason: "other-provider" })
  })

  test("an override that fails the ceiling or has no JSON output falls back to the profile", () => {
    const models = view([CHEAP, MAIN, model("ns", 0.1, [], false)], profile())
    const pricey = selectTitleModel({ ...base, models, override: "main-1" })
    expect(pricey).toMatchObject({ ok: true, modelId: "cheap-1", step: "profile" })
    if (pricey.ok)
      expect(pricey.rejected[0]).toMatchObject({ step: "override", reason: "over-ceiling" })
    const ns = selectTitleModel({ ...base, models, override: "ns" })
    expect(ns).toMatchObject({ ok: true, modelId: "cheap-1" })
    if (ns.ok) expect(ns.rejected[0]?.reason).toBe("no-structured-output")
    const missing = selectTitleModel({ ...base, models, override: "nope" })
    if (missing.ok) expect(missing.rejected[0]?.reason).toBe("not-found")
  })

  test("the config effort replaces the profile effort", () => {
    const r = selectTitleModel({ ...base, models: makeHost().host.models, effort: "high" })
    expect(r).toMatchObject({ ok: true, effort: "high" })
  })

  test("no models view, no provider or a throwing view → no-model", () => {
    expect(selectTitleModel({ ...base, models: undefined }).ok).toBe(false)
    expect(
      selectTitleModel({ ...base, models: makeHost().host.models, sessionProviderId: undefined })
        .ok,
    ).toBe(false)
    const throwing: ModelsReadApi = {
      ...hostModels(),
      utilityFor: () => {
        throw new Error("x")
      },
    }
    expect(selectTitleModel({ ...base, models: throwing })).toMatchObject({
      ok: false,
      reason: "no-model",
    })
  })
})
