/**
 * Tests of the title fixes of 2026-11-20 (B2-B5): the fork title, a slash
 * command with args, no model with no attempt used, and the first text for
 * each retry. They use a fake host (no network, no real home:
 * `MINIMAL_AGENT_HOME` is a temp dir in each env).
 *
 * This is its own file: `on_prompt_submitted.test.ts` is near the repo
 * max-lines lint budget. The small harness is a copy of the harness there.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { pluginSideband } from "../../tests/support/sideband.ts"
import type {
  EventHandlerContext,
  LlmSideRequest,
  LlmSideResult,
  ModelView,
  PromptSubmittedPayload,
  ResolvedUtilityModel,
  RunModeFact,
  SessionTitleInput,
  SessionTitleState,
  TitleHost,
  TitleSideband,
} from "../lib/host-types.ts"

import {
  createTitleHandler,
  TITLE_ATTEMPT_EVENT,
  TITLE_SAVED_EVENT,
  type TitleAttemptEvent,
} from "./on_prompt_submitted.ts"

/** The real codec (`tests/support/sideband.ts`) for `ctx.sideband`. */
const sb = await pluginSideband()

const SID = "11111111-2222-3333-4444-555555555555"
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
  sideband?: TitleSideband | undefined
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
    sideband: "sideband" in o ? o.sideband : sb,
    host: "host" in o ? o.host : fake?.host,
  }
  return { ctx, events, logs }
}

describe("title handler: fork inherit (B2)", () => {
  const PARENT = "99999999-8888-7777-6666-555555555555"

  function withSessions(
    fake: FakeHost,
    o: { parentSid?: string | null; parentTitle?: string | null; metaThrows?: boolean } = {},
  ): { metaCalls: string[] } {
    const metaCalls: string[] = []
    fake.host = {
      ...fake.host,
      sessions: {
        title: (sid) => (sid === PARENT ? (o.parentTitle ?? null) : null),
        meta: async (sid) => {
          metaCalls.push(sid)
          if (o.metaThrows) throw new Error("meta boom")
          return { sid, parentSid: o.parentSid ?? null }
        },
      },
    }
    return { metaCalls }
  }

  test("the parent title is copied as an ai title, with no model call", async () => {
    const fake = makeHost()
    withSessions(fake, { parentSid: PARENT, parentTitle: "Parent session title" })
    const t = createTitleHandler()
    const { ctx, events, logs } = makeCtx(fake)
    const saved: unknown[] = []
    const emit = ctx.emit
    ctx.emit = (ev, p) => {
      if (ev === TITLE_SAVED_EVENT) saved.push(p)
      emit(ev, p)
    }
    await t.handler(ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(0)
    expect(fake.writes).toEqual([{ sid: SID, title: "Parent session title", source: "ai" }])
    expect(saved).toEqual([{ sid: SID, title: "Parent session title", source: "ai" }])
    expect(events).toHaveLength(0)
    expect(t.stateFor(SID)).toMatchObject({ done: true, inFlight: false, attempts: 0 })
    expect(logs.some((l) => l.includes(`from parent=${PARENT}`))).toBe(true)

    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(0)
    expect(fake.writes).toHaveLength(1)
  })

  test("no parent, or a parent with no title: the normal model call", async () => {
    for (const o of [{ parentSid: null }, { parentSid: PARENT, parentTitle: null }]) {
      const fake = makeHost()
      withSessions(fake, o)
      const t = createTitleHandler()
      await t.handler(makeCtx(fake).ctx)
      await t.idle()
      expect(fake.requests).toHaveLength(1)
      expect(fake.writes[0]).toMatchObject({ source: "ai", model: "cheap-1" })
    }
  })

  test("a throwing meta() or an absent sessions API: the normal model call", async () => {
    const fake = makeHost()
    withSessions(fake, { metaThrows: true })
    const t = createTitleHandler()
    const { ctx, logs } = makeCtx(fake)
    await t.handler(ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(1)
    expect(fake.writes).toHaveLength(1)
    expect(logs.some((l) => l.includes("meta boom"))).toBe(true)

    const bare = makeHost()
    const t2 = createTitleHandler()
    await t2.handler(makeCtx(bare).ctx)
    await t2.idle()
    expect(bare.requests).toHaveLength(1)
  })

  test("a throwing setTitle for the parent title: the normal model call", async () => {
    const fake = makeHost()
    withSessions(fake, { parentSid: PARENT, parentTitle: "Parent session title" })
    let n = 0
    const setTitle = fake.host.sessionMeta!.setTitle
    fake.host = {
      ...fake.host,
      sessionMeta: {
        getTitle: fake.host.sessionMeta!.getTitle,
        setTitle: async (input) => {
          if (++n === 1) throw new Error("first write fails")
          return setTitle(input)
        },
      },
    }
    const t = createTitleHandler()
    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(1)
    expect(fake.writes).toHaveLength(1)
    expect(fake.writes[0]?.title).toBe("Title plugin spec")
  })

  test("in-flight guard: a prompt during the async meta() read makes no second check", async () => {
    const fake = makeHost()
    let release: () => void = () => {}
    const { metaCalls } = withSessions(fake, { parentSid: null })
    const meta = fake.host.sessions!.meta
    fake.host = {
      ...fake.host,
      sessions: {
        title: fake.host.sessions!.title,
        meta: async (sid) => {
          await new Promise<void>((r) => {
            release = r
          })
          return meta(sid)
        },
      },
    }
    const t = createTitleHandler()
    await t.handler(makeCtx(fake).ctx)
    const second = makeCtx(fake, { text: "a second prompt that is long enough" })
    await t.handler(second.ctx)
    expect(t.stateFor(SID)?.inFlight).toBe(true)
    expect(second.logs.some((l) => l.includes("rule=3 in-flight"))).toBe(true)
    release()
    await t.idle()
    expect(metaCalls).toHaveLength(1)
    expect(fake.requests).toHaveLength(1)
    expect(fake.writes).toHaveLength(1)
  })

  test("the fork check runs one time for each sid (a retry does not read meta again)", async () => {
    const fake = makeHost()
    const { metaCalls } = withSessions(fake, { parentSid: null })
    fake.respond = async () => ({ ...okResult(), stopReason: "timeout" })
    const t = createTitleHandler()
    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    await t.handler(makeCtx(fake).ctx)
    await t.idle()
    expect(metaCalls).toHaveLength(1)
    expect(fake.requests).toHaveLength(2)
  })
})

describe("title handler: slash command with args (B3)", () => {
  test("`/name args` sends the args as the title text", async () => {
    const fake = makeHost()
    const t = createTitleHandler()
    await t.handler(makeCtx(fake, { text: "/plan fix the session title bugs" }).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.userText).toContain(
      "<session>\nfix the session title bugs\n</session>",
    )
  })

  test("the expand event of the same command is still skipped (rule 7)", async () => {
    const fake = makeHost()
    const t = createTitleHandler()
    await t.handler(
      makeCtx(fake, { text: "/plan fix the session title bugs", source: "expand" }).ctx,
    )
    await t.idle()
    expect(fake.requests).toHaveLength(0)
  })
})

describe("title handler: no model does not use an attempt (B4)", () => {
  test("no-model: no attempt used, one log line and one event for each sid", async () => {
    const fake = makeHost({ utility: null })
    const t = createTitleHandler()
    const all: { events: TitleAttemptEvent[]; logs: string[] }[] = []
    for (let i = 0; i < 4; i++) {
      const c = makeCtx(fake)
      all.push(c)
      await t.handler(c.ctx)
      await t.idle()
    }
    expect(fake.requests).toHaveLength(0)
    expect(t.stateFor(SID)).toMatchObject({ attempts: 0, inFlight: false, done: false })
    const events = all.flatMap((c) => c.events)
    const lines = all.flatMap((c) => c.logs).filter((l) => l.includes("no-model"))
    expect(events).toHaveLength(1)
    expect(events[0]?.stopReason).toBe("no-model")
    expect(lines).toHaveLength(1)
  })

  test("over-ceiling, then a model comes: the call still has 2 attempts", async () => {
    let utility: ResolvedUtilityModel | undefined = {
      modelId: "pricey-1",
      providerId: "prov",
      structured: "json_schema",
      pricing: { inputUSD: 1.25, outputUSD: 6.25 },
    }
    const fake = makeHost()
    fake.host = {
      ...fake.host,
      models: { ...fake.host.models!, utilityFor: () => utility },
    }
    fake.respond = async () => ({ ...okResult(), stopReason: "timeout" })
    const t = createTitleHandler()
    const events: TitleAttemptEvent[] = []
    for (let i = 0; i < 3; i++) {
      const c = makeCtx(fake)
      await t.handler(c.ctx)
      await t.idle()
      events.push(...c.events)
    }
    expect(fake.requests).toHaveLength(0)
    expect(events.map((e) => e.stopReason)).toEqual(["over-ceiling"])
    utility = {
      modelId: "cheap-1",
      providerId: "prov",
      structured: "json_schema",
      pricing: CHEAP.pricing,
    }
    for (let i = 0; i < 3; i++) {
      await t.handler(makeCtx(fake).ctx)
      await t.idle()
    }
    expect(fake.requests).toHaveLength(2)
    expect(t.stateFor(SID)).toMatchObject({ attempts: 2 })
  })
})

describe("title handler: the first eligible text (B5)", () => {
  test("a retry after a failure sends the first text, not the later prompt", async () => {
    const fake = makeHost()
    let n = 0
    fake.respond = async () => (++n === 1 ? { ...okResult(), stopReason: "timeout" } : okResult())
    const t = createTitleHandler()
    await t.handler(makeCtx(fake, { text: "the first real task of the session" }).ctx)
    await t.idle()
    await t.handler(makeCtx(fake, { text: "yes, do that now please" }).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(2)
    for (const r of fake.requests) {
      expect(r.userText).toContain("the first real task of the session")
      expect(r.userText).not.toContain("do that now")
    }
    expect(t.stateFor(SID)?.firstText).toBe("the first real task of the session")
  })

  test("a retry after no-model sends the first text", async () => {
    let utility: ResolvedUtilityModel | undefined
    const fake = makeHost()
    fake.host = {
      ...fake.host,
      models: { ...fake.host.models!, utilityFor: () => utility },
    }
    const t = createTitleHandler()
    await t.handler(makeCtx(fake, { text: "the first real task of the session" }).ctx)
    await t.idle()
    utility = {
      modelId: "cheap-1",
      providerId: "prov",
      structured: "json_schema",
      pricing: CHEAP.pricing,
    }
    await t.handler(makeCtx(fake, { text: "a later prompt that is long" }).ctx)
    await t.idle()
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.userText).toContain("the first real task of the session")
  })
})
