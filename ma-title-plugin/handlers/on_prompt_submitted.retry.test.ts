/**
 * Retry policy of the title handler with a fake host and a fake clock: a
 * transient failure uses no attempt and waits a backoff, a final failure uses
 * an attempt (max 2).
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
  RunModeFact,
  SessionTitleInput,
  TitleHost,
} from "../lib/host-types.ts"

import {
  createTitleHandler,
  TITLE_ATTEMPT_EVENT,
  type TitleAttemptEvent,
} from "./on_prompt_submitted.ts"

const sb = await pluginSideband()
const SID = "ba0ad20f-0000-4000-8000-666ff6ccaa5b"
const REPL: RunModeFact = { mode: "repl", interactive: true, providerId: "prov" }
const MIN = 60_000
const T0 = Date.parse("2026-11-23T00:00:00Z")

const CHEAP: ModelView = {
  id: "cheap-1",
  providerId: "prov",
  tags: ["utility"],
  capabilities: { structuredOutputs: true },
  pricing: { inputUSD: 0.1, outputUSD: 0.5 },
}

function okResult(): LlmSideResult {
  return {
    text: JSON.stringify({ title: "Retry policy spec" }),
    json: { title: "Retry policy spec" },
    stopReason: "end_turn",
    model: "cheap-1",
    provider: "prov",
    usage: { inputTokens: 10, outputTokens: 5 },
    latencyMs: 100,
  }
}

/** Core `reject("transport", ...)` for a connection reset. */
function networkError(): LlmSideResult {
  return {
    ...okResult(),
    text: "",
    json: undefined,
    stopReason: "error",
    reason: "transport",
    detail: "read ECONNRESET",
  }
}

/** A final failure: the model hit the token limit. */
function maxTokens(): LlmSideResult {
  return { ...okResult(), stopReason: "max_tokens" }
}

interface Fake {
  host: TitleHost
  requests: LlmSideRequest[]
  writes: SessionTitleInput[]
  respond: () => LlmSideResult
}

function makeHost(): Fake {
  const fake: Fake = {
    requests: [],
    writes: [],
    respond: okResult,
    host: undefined as unknown as TitleHost,
  }
  fake.host = {
    llm: {
      request: async (req) => {
        fake.requests.push(req)
        return fake.respond()
      },
    },
    sessionMeta: {
      getTitle: () => (fake.writes.length > 0 ? { ai: { title: "x" } as never } : {}),
      setTitle: async (input) => {
        fake.writes.push(input)
      },
    },
    models: {
      find: (id) => (id === CHEAP.id ? CHEAP : undefined),
      findForProvider: (id) => (id === CHEAP.id ? CHEAP : undefined),
      list: () => [CHEAP],
      findByTags: () => CHEAP,
      utilityFor: () => ({
        modelId: "cheap-1",
        providerId: "prov",
        structured: "json_schema" as const,
        pricing: CHEAP.pricing,
      }),
    },
  }
  return fake
}

let home: string
let env: Record<string, string>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ma-title-retry-"))
  env = { MINIMAL_AGENT_HOME: join(home, ".minimal-agent"), MINIMAL_AGENT_TITLE: "1" }
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function makeCtx(
  fake: Fake,
  text = "write the design spec for a title plugin",
): { ctx: EventHandlerContext; events: TitleAttemptEvent[]; logs: string[] } {
  const events: TitleAttemptEvent[] = []
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
      if (ev === TITLE_ATTEMPT_EVENT) events.push(p as TitleAttemptEvent)
    },
    abort: new AbortController().signal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: (_s, m) => logs.push(m) },
    agent: { sessionId: SID, model: "main-1" },
    run: REPL,
    sideband: sb,
    host: fake.host,
  }
  return { ctx, events, logs }
}

/** A handler with a fake clock (`clock.t` in epoch ms). */
function setup() {
  const fake = makeHost()
  const clock = { t: T0 }
  const t = createTitleHandler({ now: () => new Date(clock.t) })
  const prompt = async (text?: string) => {
    const c = makeCtx(fake, text)
    await t.handler(c.ctx)
    await t.idle()
    return c
  }
  return { fake, clock, t, prompt }
}

describe("title handler: transient failures retry with a backoff", () => {
  test("7 network errors never reach max-attempts, and the wait is 1, 2, 5, 15, 30, then 60 min", async () => {
    const { fake, clock, t, prompt } = setup()
    fake.respond = networkError
    const waits: number[] = []
    for (let i = 0; i < 7; i++) {
      const c = await prompt()
      expect(fake.requests).toHaveLength(i + 1)
      expect(c.events).toHaveLength(1)
      expect(c.events[0]).toMatchObject({ stopReason: "error", retry: "transient", written: false })
      const s = t.stateFor(SID)
      expect(s).toMatchObject({ attempts: 0, inFlight: false, transientFailures: i + 1 })
      const after = Number(s?.retryAfter)
      waits.push((after - clock.t) / MIN)
      expect(c.logs.some((l) => l.includes("retry=transient") && l.includes("next="))).toBe(true)
      clock.t = after
    }
    expect(waits).toEqual([1, 2, 5, 15, 30, 60, 60])
  })

  test("a prompt inside the backoff makes no call (backoff)", async () => {
    const { fake, clock, prompt } = setup()
    fake.respond = networkError
    await prompt()
    clock.t = T0 + MIN - 1
    const c = await prompt()
    expect(fake.requests).toHaveLength(1)
    expect(c.events).toHaveLength(0)
    expect(c.logs.some((l) => l.includes("backoff"))).toBe(true)
  })

  test("a prompt after the backoff makes a call with the first text", async () => {
    const { fake, clock, prompt } = setup()
    fake.respond = networkError
    await prompt("the first real task of the session")
    clock.t = T0 + MIN
    fake.respond = okResult
    await prompt("yes, do that now please")
    expect(fake.requests).toHaveLength(2)
    expect(fake.requests[1]?.userText).toContain("the first real task of the session")
    expect(fake.requests[1]?.userText).not.toContain("do that now")
    expect(fake.writes).toHaveLength(1)
  })

  test("a timeout result is transient", async () => {
    const { fake, t, prompt } = setup()
    fake.respond = () => ({
      ...okResult(),
      json: undefined,
      stopReason: "timeout",
      reason: "timeout",
    })
    const c = await prompt()
    expect(c.events[0]?.retry).toBe("transient")
    expect(t.stateFor(SID)).toMatchObject({ attempts: 0, transientFailures: 1 })
  })

  test("success after transient errors resets the state", async () => {
    const { fake, clock, t, prompt } = setup()
    fake.respond = networkError
    await prompt()
    clock.t += MIN
    await prompt()
    expect(t.stateFor(SID)).toMatchObject({ transientFailures: 2 })
    clock.t += 2 * MIN
    fake.respond = okResult
    const c = await prompt()
    expect(c.events[0]).toMatchObject({ written: true })
    expect(c.events[0]?.retry).toBeUndefined()
    const s = t.stateFor(SID)
    expect(s).toMatchObject({ done: true, transientFailures: 0, attempts: 1 })
    expect(s?.retryAfter).toBeUndefined()
  })
})

describe("title handler: final failures use an attempt", () => {
  test("2 final errors stop as today (max-attempts)", async () => {
    const { fake, t, prompt } = setup()
    fake.respond = maxTokens
    const first = await prompt()
    expect(first.events[0]).toMatchObject({ stopReason: "max_tokens", retry: "final" })
    expect(first.logs.some((l) => l.includes("retry=final"))).toBe(true)
    await prompt()
    const third = await prompt()
    expect(fake.requests).toHaveLength(2)
    expect(third.logs.some((l) => l.includes("max-attempts"))).toBe(true)
    expect(t.stateFor(SID)).toMatchObject({ attempts: 2, done: false })
  })

  test("a mix (transient, final, transient, final) stops after the 2nd final", async () => {
    const { fake, clock, t, prompt } = setup()
    const seq = [networkError, maxTokens, networkError, maxTokens, okResult]
    let i = 0
    fake.respond = () => (seq[i++] ?? okResult)()
    for (let k = 0; k < 6; k++) {
      await prompt()
      clock.t += 61 * MIN
    }
    expect(fake.requests).toHaveLength(4)
    expect(fake.writes).toHaveLength(0)
    expect(t.stateFor(SID)).toMatchObject({ attempts: 2, done: false })
  })

  test("an unknown stop reason is final", async () => {
    const { fake, t, prompt } = setup()
    fake.respond = () => ({ ...okResult(), stopReason: "weird_new_stop" })
    const c = await prompt()
    expect(c.events[0]?.retry).toBe("final")
    expect(t.stateFor(SID)).toMatchObject({ attempts: 1 })
    expect(t.stateFor(SID)?.retryAfter).toBeUndefined()
  })

  test("write-failed not-owned is final", async () => {
    const { fake, t, prompt } = setup()
    fake.host = {
      ...fake.host,
      sessionMeta: {
        getTitle: () => ({}),
        setTitle: async () => {
          throw Object.assign(new Error("not yours"), { code: "not-owned" })
        },
      },
    }
    const c = await prompt()
    expect(c.events[0]).toMatchObject({ stopReason: "write-failed", retry: "final" })
    expect(t.stateFor(SID)).toMatchObject({ attempts: 1 })
  })
})
