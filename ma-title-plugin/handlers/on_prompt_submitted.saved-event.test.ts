/**
 * Tests of the `title.saved` event (the UI refresh signal) of the title
 * handler. They use a fake host (no network, no real home: `MINIMAL_AGENT_HOME`
 * is a temp dir in each env).
 *
 * This is its own file: `on_prompt_submitted.test.ts` is near the repo
 * max-lines lint budget. It has its own small harness, like the other split
 * test files of this repo.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { pluginSideband } from "../../tests/support/sideband.ts"
import type {
  EventHandlerContext,
  LlmSideResult,
  ModelView,
  PromptSubmittedPayload,
  ResolvedUtilityModel,
  RunModeFact,
  SessionTitleInput,
  SessionTitleState,
  TitleHost,
} from "../lib/host-types.ts"

import {
  createTitleHandler,
  TITLE_ATTEMPT_EVENT,
  TITLE_SAVED_EVENT,
  type TitleAttemptEvent,
  type TitleSavedEvent,
} from "./on_prompt_submitted.ts"

/** The real codec (`tests/support/sideband.ts`) for `ctx.sideband`. */
const sb = await pluginSideband()

const SID = "ba0ad20f-0000-4000-8000-666ff6ccaa5b"
const REPL: RunModeFact = { mode: "repl", interactive: true, providerId: "prov" }

const CHEAP: ModelView = {
  id: "cheap-1",
  providerId: "prov",
  tags: ["utility", "haiku"],
  capabilities: { structuredOutputs: true },
  pricing: { inputUSD: 0.1, outputUSD: 0.5 },
}
const MAIN: ModelView = {
  id: "main-1",
  providerId: "prov",
  tags: ["opus", "flagship"],
  capabilities: { structuredOutputs: true },
  pricing: { inputUSD: 5, outputUSD: 25 },
}

interface Fake {
  host: TitleHost
  /** Number of side calls. */
  calls: number
  writes: SessionTitleInput[]
  /** The order of the writes (`"write"`) and of the `title.saved` events (`"saved"`). */
  trail: string[]
  titleState: SessionTitleState
  respond: () => Promise<LlmSideResult>
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

/** A fake host. `profile: false` = the provider has no title profile. */
function makeFake(opts: { profile?: boolean } = {}): Fake {
  const models = [CHEAP, MAIN]
  const utility: ResolvedUtilityModel | undefined =
    opts.profile === false
      ? undefined
      : {
          modelId: "cheap-1",
          providerId: "prov",
          structured: "json_schema",
          thinkingOff: true,
          effort: "low",
          stream: "off",
          pricing: CHEAP.pricing,
        }
  const fake: Fake = {
    calls: 0,
    writes: [],
    trail: [],
    titleState: {},
    respond: async () => okResult(),
    host: undefined as unknown as TitleHost,
  }
  fake.host = {
    llm: {
      request: () => {
        fake.calls++
        return fake.respond()
      },
    },
    sessionMeta: {
      getTitle: (sid) => (sid === SID ? fake.titleState : {}),
      setTitle: async (input) => {
        fake.writes.push(input)
        fake.trail.push("write")
      },
    },
    models: {
      find: (id) => models.find((m) => m.id === id),
      findForProvider: (id, p) => models.find((m) => m.id === id && m.providerId === p),
      list: () => models,
      findByTags: (p, tags) =>
        models.find((m) => m.providerId === p && tags.every((t) => (m.tags ?? []).includes(t))),
      utilityFor: () => utility,
    },
  }
  return fake
}

let home: string
let env: Record<string, string>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ma-title-saved-"))
  env = { MINIMAL_AGENT_HOME: join(home, ".minimal-agent"), MINIMAL_AGENT_TITLE: "1" }
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** A handler context with a prompt that the user typed. It records the events. */
function makeCtx(
  fake: Fake,
  text = "write the design spec for a title plugin",
): {
  ctx: EventHandlerContext
  attempts: TitleAttemptEvent[]
  saved: TitleSavedEvent[]
  logs: string[]
} {
  const attempts: TitleAttemptEvent[] = []
  const saved: TitleSavedEvent[] = []
  const logs: string[] = []
  const payload: PromptSubmittedPayload = {
    text,
    cwd: "/tmp",
    sid: SID,
    exit: "submitted",
    queuePos: 0,
    source: "user",
  }
  const ctx: EventHandlerContext = {
    event: "prompt.submitted",
    payload,
    env,
    emit: (ev, p) => {
      if (ev === TITLE_ATTEMPT_EVENT) attempts.push(p as TitleAttemptEvent)
      if (ev === TITLE_SAVED_EVENT) {
        saved.push(p as TitleSavedEvent)
        fake.trail.push("saved")
      }
    },
    abort: new AbortController().signal,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: (_s, m) => logs.push(m),
    },
    agent: { sessionId: SID, model: "main-1" },
    run: REPL,
    sideband: sb,
    host: fake.host,
  }
  return { ctx, attempts, saved, logs }
}

const USER_TITLE: SessionTitleState = {
  user: { kind: "title", v: 1, sid: SID, title: "My name", source: "user", at: "x" },
}

describe("title.saved: sent after a title was written", () => {
  test("one event after the write, with the captured sid and the saved title", async () => {
    const fake = makeFake()
    const t = createTitleHandler()
    const { ctx, saved } = makeCtx(fake)
    await t.handler(ctx)
    await t.idle()

    expect(TITLE_SAVED_EVENT).toBe("title.saved")
    expect(saved).toEqual([{ sid: SID, title: "Title plugin spec", source: "ai" }])
    // The write comes first: a subscriber that reads the title finds it.
    expect(fake.trail).toEqual(["write", "saved"])
  })

  test("the event has the sanitized title that setTitle got", async () => {
    const fake = makeFake()
    fake.respond = async () => okResult('"fix the footer."')
    const t = createTitleHandler()
    const { ctx, saved } = makeCtx(fake)
    await t.handler(ctx)
    await t.idle()

    expect(fake.writes[0]?.title).toBe("Fix the footer")
    expect(saved).toEqual([{ sid: SID, title: "Fix the footer", source: "ai" }])
  })

  test("a done session sends no second event", async () => {
    const fake = makeFake()
    const t = createTitleHandler()
    const first = makeCtx(fake)
    await t.handler(first.ctx)
    await t.idle()
    const second = makeCtx(fake, "a second prompt that is long")
    await t.handler(second.ctx)
    await t.idle()

    expect(fake.calls).toBe(1)
    expect(first.saved).toHaveLength(1)
    expect(second.saved).toHaveLength(0)
  })

  test("a throwing emit does not turn a good write into a failure", async () => {
    const fake = makeFake()
    const t = createTitleHandler()
    const { ctx, attempts, logs } = makeCtx(fake)
    const emitAttempt = ctx.emit
    ctx.emit = (ev, p) => {
      if (ev === TITLE_SAVED_EVENT) throw new Error("bus down")
      emitAttempt(ev, p)
    }
    await t.handler(ctx)
    await t.idle()

    expect(fake.writes).toHaveLength(1)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ stopReason: "end_turn", written: true })
    expect(t.stateFor(SID)).toMatchObject({ attempts: 1, done: true, inFlight: false })
    expect(logs.some((l) => l.includes("write-failed"))).toBe(false)
  })
})

describe("title.saved: not sent when no title was written", () => {
  const cases: Array<[string, (fake: Fake) => void]> = [
    [
      "the request throws",
      (f) => {
        f.respond = async () => {
          throw new Error("boom")
        }
      },
    ],
    [
      "the model stops on max_tokens",
      (f) => {
        f.respond = async () => ({ ...okResult(), stopReason: "max_tokens" })
      },
    ],
    [
      "a user title appears during the call",
      (f) => {
        f.respond = async () => {
          f.titleState = USER_TITLE
          return okResult()
        }
      },
    ],
    [
      "a user title exists before the call",
      (f) => {
        f.titleState = USER_TITLE
      },
    ],
  ]
  for (const [name, arrange] of cases) {
    test(`no event when ${name}`, async () => {
      const fake = makeFake()
      arrange(fake)
      const t = createTitleHandler()
      const { ctx, saved } = makeCtx(fake)
      await t.handler(ctx)
      await t.idle()

      expect(fake.writes).toHaveLength(0)
      expect(saved).toHaveLength(0)
      expect(fake.trail).toEqual([])
    })
  }

  test("no event when the provider has no title profile (no model)", async () => {
    const fake = makeFake({ profile: false })
    const t = createTitleHandler()
    const { ctx, saved } = makeCtx(fake)
    await t.handler(ctx)
    await t.idle()

    expect(fake.calls).toBe(0)
    expect(saved).toHaveLength(0)
  })

  test("no event when setTitle throws (write-failed)", async () => {
    const fake = makeFake()
    fake.host = {
      ...fake.host,
      sessionMeta: {
        getTitle: () => ({}),
        setTitle: async () => {
          throw Object.assign(new Error("cannot write"), { code: "write-failed" })
        },
      },
    }
    const t = createTitleHandler()
    const { ctx, attempts, saved } = makeCtx(fake)
    await t.handler(ctx)
    await t.idle()

    expect(attempts[0]).toMatchObject({ stopReason: "write-failed", written: false })
    expect(saved).toHaveLength(0)
  })
})
