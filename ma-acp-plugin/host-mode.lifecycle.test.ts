/**
 * In-process tests for the `host-mode.ts` life cycle: shutdown on the
 * context abort signal, stdin EOF during a turn, the cancel stop reason
 * when a run settles "completed" after a cancel, and up-front params
 * checks (-32602).
 *
 * @module host-mode.lifecycle.test
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import {
  createFakeRuntime,
  type FakeRuntime,
  type ScriptedTurn,
} from "./__fixtures__/fake-runtime.ts"
import { openInMemorySession, startInMemoryHost } from "./__fixtures__/in-memory-host.ts"
import { retryBoundaryText } from "./encoder.ts"

const text = (t: string) => [{ type: "text", text: t }]

/** The agent's advert in the `initialize` result. */
const LOCAL_ADVERT = { version: 1, features: ["usage", "structuredOutput", "sampling"] }

describe("session/new cwd check", () => {
  // macOS: the temp dir /var/folders/... is a symlink to /private/var/...
  // The process cwd is the real path. A client can send the symlink path.
  it("accepts a cwd that is a symlink to the process cwd, and refuses another dir", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "acp-cwd-")))
    try {
      const real = join(root, "real")
      const other = join(root, "other")
      mkdirSync(real)
      mkdirSync(other)
      symlinkSync(real, join(root, "link"))
      const h = startInMemoryHost(createFakeRuntime(), real)
      h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
      await h.reply(1)
      h.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: other } })
      expect((await h.reply(2)).error?.code).toBe(-32602)
      h.send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/new",
        params: { cwd: join(root, "link"), mcpServers: [] },
      })
      const created = await h.reply(3)
      expect(created.error).toBeUndefined()
      expect(typeof created.result?.sessionId).toBe("string")
      h.end()
      expect(await h.exit).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("host-mode life cycle", () => {
  it("on ctx.abort: aborts the run, answers the prompt, closes the session, and returns", async () => {
    const rt = createFakeRuntime()
    rt.turns.push({ events: [], outcome: "aborted", waitForAbort: true })
    const h = await openInMemorySession(rt)
    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: h.sessionId, prompt: text("go") },
    })
    await Bun.sleep(20)
    h.abort.abort()
    // stdin stays open: only the abort signal can end the handler.
    const code = await Promise.race([h.exit, Bun.sleep(1000).then(() => "timeout" as const)])
    expect(code).toBe(0)
    expect(rt.lastRunAborted).toBe(true)
    expect(h.lines().find((m) => m.id === 3)?.result).toEqual({
      stopReason: "cancelled",
      usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
    })
    expect(rt.closeCalls).toBe(1)
  })

  it("returns at once when ctx.abort fires with no turn running", async () => {
    const rt = createFakeRuntime()
    const h = await openInMemorySession(rt)
    h.abort.abort()
    const code = await Promise.race([h.exit, Bun.sleep(1000).then(() => "timeout" as const)])
    expect(code).toBe(0)
    expect(rt.closeCalls).toBe(1)
  })

  it("on stdin EOF during a turn: aborts the run, answers the prompt, then closes the session", async () => {
    const rt = createFakeRuntime()
    rt.turns.push({ events: [], outcome: "aborted", waitForAbort: true })
    const h = await openInMemorySession(rt)
    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: h.sessionId, prompt: text("go") },
    })
    await Bun.sleep(20)
    h.end()
    const code = await Promise.race([h.exit, Bun.sleep(1000).then(() => "timeout" as const)])
    expect(code).toBe(0)
    expect(rt.lastRunAborted).toBe(true)
    // The reply is on stdout BEFORE the handler returns.
    expect(h.lines().find((m) => m.id === 3)?.result).toEqual({
      stopReason: "cancelled",
      usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
    })
    expect(rt.closeCalls).toBe(1)
  })

  it("answers cancelled when the run settles completed after session/cancel", async () => {
    const rt = createFakeRuntime()
    rt.turns.push({ events: [], outcome: "completed", waitForAbort: true })
    const h = await openInMemorySession(rt)
    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: h.sessionId, prompt: text("go") },
    })
    await Bun.sleep(20)
    h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: h.sessionId } })
    expect((await h.reply(3)).result).toEqual({
      stopReason: "cancelled",
      usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
    })
    h.end()
    expect(await h.exit).toBe(0)
  })
})

describe("host-mode params checks", () => {
  it("answers -32602 for missing or wrong-typed params, never -32603", async () => {
    const rt = createFakeRuntime()
    const h = startInMemoryHost(rt)
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
    await h.reply(1)

    h.send({ jsonrpc: "2.0", id: 2, method: "session/new" })
    h.send({ jsonrpc: "2.0", id: 3, method: "session/new", params: null })
    h.send({ jsonrpc: "2.0", id: 4, method: "session/new", params: { cwd: 7 } })
    for (const id of [2, 3, 4]) expect((await h.reply(id)).error?.code).toBe(-32602)

    h.send({ jsonrpc: "2.0", id: 5, method: "session/new", params: { cwd: "/work" } })
    const sessionId = (await h.reply(5)).result?.sessionId as string
    expect(sessionId).toBe("sess_fake")

    h.send({ jsonrpc: "2.0", id: 6, method: "session/prompt" })
    h.send({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: "x" })
    h.send({ jsonrpc: "2.0", id: 8, method: "session/set_config_option" })
    h.send({ jsonrpc: "2.0", id: 9, method: "session/set_config_option", params: [1] })
    h.send({
      jsonrpc: "2.0",
      id: 10,
      method: "session/set_config_option",
      params: { sessionId, configId: 3, value: "alpha" },
    })
    for (const id of [6, 7, 8, 9, 10]) {
      const r = await h.reply(id)
      expect(r.error?.code).toBe(-32602)
      expect(r.error?.message).not.toContain("TypeError")
    }
    // A cancel with no params is ignored, and the session still works.
    h.send({ jsonrpc: "2.0", method: "session/cancel" })
    h.send({
      jsonrpc: "2.0",
      id: 11,
      method: "session/prompt",
      params: { sessionId, prompt: text("hi") },
    })
    expect((await h.reply(11)).result).toEqual({
      stopReason: "end_turn",
      usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
    })
    h.end()
    expect(await h.exit).toBe(0)
  })
})

describe("initialize: extension negotiation (minimal-agent/ext)", () => {
  const caps = (r: Record<string, unknown> | undefined) =>
    r?.agentCapabilities as Record<string, unknown> & { _meta?: Record<string, unknown> }

  it("advertises agentCapabilities._meta[minimal-agent/ext] to a client with no _meta", async () => {
    const h = startInMemoryHost(createFakeRuntime())
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false } } },
    })
    const r = await h.reply(1)
    expect(r.error).toBeUndefined()
    const ac = caps(r.result)
    expect(ac._meta?.["minimal-agent/ext"]).toEqual(LOCAL_ADVERT)
    // Standard keys are kept.
    expect(ac.loadSession).toBe(false)
    expect(ac.promptCapabilities).toEqual({ image: false, audio: false, embeddedContext: false })
    h.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/work", mcpServers: [] },
    })
    expect(typeof (await h.reply(2)).result?.sessionId).toBe("string")
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("initializes a client that advertises minimal-agent/ext and other _meta keys", async () => {
    const h = startInMemoryHost(createFakeRuntime())
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          _meta: {
            "minimal-agent/ext": { version: 1, features: ["usage", "structuredOutput"] },
            "com.example/x": 1,
          },
        },
      },
    })
    const r = await h.reply(1)
    expect(r.error).toBeUndefined()
    expect(caps(r.result)._meta?.["minimal-agent/ext"]).toEqual(LOCAL_ADVERT)
    h.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/work", mcpServers: [] },
    })
    expect(typeof (await h.reply(2)).result?.sessionId).toBe("string")
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("initializes a client with a malformed minimal-agent/ext value", async () => {
    const h = startInMemoryHost(createFakeRuntime())
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { _meta: { "minimal-agent/ext": "yes" } } },
    })
    const r = await h.reply(1)
    expect(r.error).toBeUndefined()
    expect(caps(r.result)._meta?.["minimal-agent/ext"]).toEqual(LOCAL_ADVERT)
    h.end()
    expect(await h.exit).toBe(0)
  })
})

describe("unknown extension methods", () => {
  it("answers -32601 to an unknown _x/y request", async () => {
    const h = await openInMemorySession(createFakeRuntime())
    h.send({ jsonrpc: "2.0", id: 7, method: "_x/y", params: {} })
    expect((await h.reply(7)).error?.code).toBe(-32601)
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("sends no reply to an unknown _x/y notification and stays up", async () => {
    const h = await openInMemorySession(createFakeRuntime())
    const before = h.lines().length
    h.send({ jsonrpc: "2.0", method: "_x/y", params: { a: 1 } })
    await Bun.sleep(30)
    expect(h.lines().length).toBe(before)
    expect(h.isExited()).toBe(false)
    // The connection still answers.
    h.send({ jsonrpc: "2.0", id: 8, method: "_x/z" })
    expect((await h.reply(8)).error?.code).toBe(-32601)
    h.end()
    expect(await h.exit).toBe(0)
  })
})

describe("systemPrompt (ACP unstable sessionCapabilities.systemPrompt)", () => {
  const init = async (h: ReturnType<typeof startInMemoryHost>) => {
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
    return h.reply(1)
  }
  const newSession = (h: ReturnType<typeof startInMemoryHost>, id: number, extra: object) =>
    h.send({
      jsonrpc: "2.0",
      id,
      method: "session/new",
      params: { cwd: "/work", mcpServers: [], ...extra },
    })

  it("initialize advertises sessionCapabilities.systemPrompt with mode.override", async () => {
    const h = startInMemoryHost(createFakeRuntime())
    const r = await init(h)
    const ac = r.result?.agentCapabilities as Record<string, unknown>
    expect(ac.sessionCapabilities).toEqual({ systemPrompt: { mode: { override: {} } } })
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("a runtime with no capabilities object: no systemPrompt, ext [usage], systemPrompt is -32602", async () => {
    const rt = createFakeRuntime({ capabilities: null })
    const h = startInMemoryHost(rt)
    const r = await init(h)
    const ac = r.result?.agentCapabilities as Record<string, unknown> & {
      _meta?: Record<string, unknown>
    }
    expect(ac.sessionCapabilities).toBeUndefined()
    expect(ac._meta?.["minimal-agent/ext"]).toEqual({ version: 1, features: ["usage"] })
    newSession(h, 2, { systemPrompt: { mode: "append", content: text("rules") } })
    newSession(h, 3, { systemPrompt: { mode: "override", content: text("rules") } })
    const r2 = await h.reply(2)
    expect(r2.error?.code).toBe(-32602)
    expect(r2.error?.message).toContain("not supported")
    expect((await h.reply(3)).error?.code).toBe(-32602)
    expect(rt.openSessionCalls).toEqual([])
    // Without systemPrompt the session opens.
    newSession(h, 4, {})
    expect((await h.reply(4)).result?.sessionId).toBe("sess_fake")
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("append only (no override): systemPrompt {} and override is -32602", async () => {
    const rt = createFakeRuntime({
      capabilities: {
        systemPrompt: { append: true, override: false },
        outputSchema: false,
        temperature: true,
      },
    })
    const h = startInMemoryHost(rt)
    const r = await init(h)
    const ac = r.result?.agentCapabilities as Record<string, unknown> & {
      _meta?: Record<string, unknown>
    }
    expect(ac.sessionCapabilities).toEqual({ systemPrompt: {} })
    expect(ac._meta?.["minimal-agent/ext"]).toEqual({ version: 1, features: ["usage", "sampling"] })
    newSession(h, 2, { systemPrompt: { mode: "override", content: text("rules") } })
    expect((await h.reply(2)).error?.code).toBe(-32602)
    newSession(h, 3, { systemPrompt: { mode: "append", content: text("rules") } })
    expect((await h.reply(3)).result?.sessionId).toBe("sess_fake")
    expect(rt.openSessionCalls).toEqual([{ systemPrompt: { mode: "append", text: "rules" } }])
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("a structuredOutput key is ignored when the runtime cannot apply it", async () => {
    const rt = createFakeRuntime({
      capabilities: {
        systemPrompt: { append: false, override: false },
        outputSchema: false,
        temperature: false,
      },
    })
    const h = startInMemoryHost(rt)
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          _meta: {
            "minimal-agent/ext": {
              version: 1,
              features: ["usage", "structuredOutput", "sampling"],
            },
          },
        },
      },
    })
    await h.reply(1)
    newSession(h, 2, {})
    const { sessionId } = (await h.reply(2)).result as { sessionId: string }
    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: text("hi"),
        _meta: {
          "minimal-agent/outputSchema": { type: "object" },
          "minimal-agent/sampling": { temperature: 0.2 },
        },
      },
    })
    expect((await h.reply(3)).result?.stopReason).toBe("end_turn")
    expect(rt.runOptions).toEqual([{ emitDeltas: true }])
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("append: passes the joined text blocks to openSession", async () => {
    const rt = createFakeRuntime()
    const h = startInMemoryHost(rt)
    await init(h)
    newSession(h, 2, {
      systemPrompt: {
        mode: "append",
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
    })
    expect((await h.reply(2)).result?.sessionId).toBe("sess_fake")
    expect(rt.openSessionCalls).toEqual([{ systemPrompt: { mode: "append", text: "one\n\ntwo" } }])
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("override: passes mode override to openSession", async () => {
    const rt = createFakeRuntime()
    const h = startInMemoryHost(rt)
    await init(h)
    newSession(h, 2, { systemPrompt: { mode: "override", content: text("be brief") } })
    expect((await h.reply(2)).result?.sessionId).toBe("sess_fake")
    expect(rt.openSessionCalls).toEqual([{ systemPrompt: { mode: "override", text: "be brief" } }])
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("answers -32602 for an unknown mode, an image block, or bad content, and opens no session", async () => {
    const rt = createFakeRuntime()
    const h = startInMemoryHost(rt)
    await init(h)
    newSession(h, 2, { systemPrompt: { mode: "full", content: text("x") } })
    newSession(h, 3, {
      systemPrompt: {
        mode: "append",
        content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      },
    })
    newSession(h, 4, { systemPrompt: { mode: "append", content: "x" } })
    newSession(h, 5, { systemPrompt: "x" })
    const r2 = await h.reply(2)
    expect(r2.error?.code).toBe(-32602)
    expect(r2.error?.message).toContain("mode")
    const r3 = await h.reply(3)
    expect(r3.error?.code).toBe(-32602)
    expect(r3.error?.message).toContain('"image"')
    expect((await h.reply(4)).error?.code).toBe(-32602)
    expect((await h.reply(5)).error?.code).toBe(-32602)
    expect(rt.openSessionCalls).toEqual([])
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("no systemPrompt field (or empty text): openSession gets no options", async () => {
    const rt = createFakeRuntime()
    const h = startInMemoryHost(rt)
    await init(h)
    newSession(h, 2, {})
    expect((await h.reply(2)).result?.sessionId).toBe("sess_fake")
    expect(rt.openSessionCalls).toEqual([undefined])
    h.end()
    expect(await h.exit).toBe(0)

    const rt2 = createFakeRuntime()
    const h2 = startInMemoryHost(rt2)
    await init(h2)
    newSession(h2, 2, { systemPrompt: { mode: "append", content: text("  ") } })
    expect((await h2.reply(2)).result?.sessionId).toBe("sess_fake")
    expect(rt2.openSessionCalls).toEqual([undefined])
    h2.end()
    expect(await h2.exit).toBe(0)
  })
})

/** Start a host whose client advertises `features` (and, when set, `session.notices`). */
async function openExtSession(rt: FakeRuntime, features: string[], notices = false) {
  const h = startInMemoryHost(rt)
  h.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        ...(notices ? { session: { notices: {} } } : {}),
        _meta: { "minimal-agent/ext": { version: 1, features } },
      },
    },
  })
  await h.reply(1)
  h.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/work", mcpServers: [] } })
  const sessionId = (await h.reply(2)).result?.sessionId as string
  let nextId = 10
  const prompt = async (meta?: Record<string, unknown>) => {
    const id = nextId++
    h.send({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: { sessionId, prompt: text("go"), ...(meta ? { _meta: meta } : {}) },
    })
    return h.reply(id)
  }
  return { ...h, sessionId, prompt }
}

/** A completed turn whose final text is `t`, with 3 in and 2 out tokens. */
const textTurn = (t: string): ScriptedTurn => ({
  events: [
    { type: "text_delta", id: "1:text", text: t },
    {
      type: "turn_completed",
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 2 },
    } as AgentEvent,
  ],
  outcome: "completed",
})

const SCHEMA = {
  type: "object",
  properties: { n: { type: "integer" } },
  required: ["n"],
}
const meta = (r: { result?: Record<string, unknown> }) =>
  r.result?._meta as Record<string, unknown> | undefined

describe("structuredOutput (contract 5.e)", () => {
  it("passes outputSchema to run and puts the parsed value in _meta[minimal-agent/output]", async () => {
    const rt = createFakeRuntime()
    rt.turns.push(textTurn('{"n": 4}'))
    const h = await openExtSession(rt, ["usage", "structuredOutput"])
    const r = await h.prompt({ "minimal-agent/outputSchema": SCHEMA })
    expect(rt.runOptions).toEqual([{ emitDeltas: true, outputSchema: SCHEMA }])
    expect(r.result?.stopReason).toBe("end_turn")
    expect(meta(r)?.["minimal-agent/output"]).toEqual({ n: 4 })
    expect(meta(r)?.["minimal-agent/outputError"]).toBeUndefined()
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("retries once with a corrective message, then succeeds, and counts usage of both runs", async () => {
    const rt = createFakeRuntime()
    rt.turns.push(textTurn("not json"), textTurn('{"n": 1}'))
    const h = await openExtSession(rt, ["usage", "structuredOutput"])
    const r = await h.prompt({ "minimal-agent/outputSchema": SCHEMA })
    expect(rt.prompts.length).toBe(2)
    expect(rt.prompts[1]).toContain("not valid JSON")
    expect(rt.runOptions[1]?.outputSchema).toEqual(SCHEMA)
    expect(meta(r)?.["minimal-agent/output"]).toEqual({ n: 1 })
    expect(meta(r)?.["minimal-agent/usage"]).toEqual({ inputTokens: 6, outputTokens: 4 })
    // One reply for the turn.
    expect(h.lines().filter((m) => m.id === 10 && m.method === undefined).length).toBe(1)
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("gives outputError after 2 retries, with a normal stopReason", async () => {
    const rt = createFakeRuntime()
    rt.turns.push(textTurn('{"n": "x"}'), textTurn('{"n": "y"}'), textTurn('{"m": 1}'))
    const h = await openExtSession(rt, ["structuredOutput"])
    const r = await h.prompt({ "minimal-agent/outputSchema": SCHEMA })
    expect(r.error).toBeUndefined()
    expect(rt.prompts.length).toBe(3)
    expect(r.result?.stopReason).toBe("end_turn")
    expect(meta(r)?.["minimal-agent/output"]).toBeUndefined()
    const err = meta(r)?.["minimal-agent/outputError"] as { message: string }
    expect(err.message).toContain('missing required property "n"')
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("streams each retry attempt with its own messageId, the first id unchanged", async () => {
    const rt = createFakeRuntime()
    rt.turns.push(textTurn("not json"), textTurn('{"n": "x"}'), textTurn('{"n": 1}'))
    const h = await openExtSession(rt, ["structuredOutput"])
    const r = await h.prompt({ "minimal-agent/outputSchema": SCHEMA })
    expect(meta(r)?.["minimal-agent/output"]).toEqual({ n: 1 })
    const ids = h
      .lines()
      .map((m) => (m.params as { update?: Record<string, unknown> } | undefined)?.update)
      .filter((u) => u?.sessionUpdate === "agent_message_chunk")
      .map((u) => u?.messageId)
    expect(ids).toEqual(["1:text", "1:text-attempt-2", "1:text-attempt-3"])
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("a retry-boundary event on attempt 2 gets the attempt suffix like the old marker text_delta", async () => {
    const rt = createFakeRuntime()
    const turn2 = textTurn('{"n": 1}')
    rt.turns.push(textTurn("not json"), {
      ...turn2,
      events: [{ type: "retry-boundary", id: "1:text", attempt: 2 } as AgentEvent, ...turn2.events],
    })
    const h = await openExtSession(rt, ["structuredOutput"])
    await h.prompt({ "minimal-agent/outputSchema": SCHEMA })
    const chunks = h
      .lines()
      .map((m) => (m.params as { update?: Record<string, unknown> } | undefined)?.update)
      .filter((u) => u?.sessionUpdate === "agent_message_chunk")
    const marker = chunks.find(
      (u) => (u?.content as { text?: string } | undefined)?.text === retryBoundaryText(2),
    )
    expect(marker?.messageId).toBe("1:text-attempt-2")
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("a hostile deep schema gives outputError, no throw, and the next turn usage starts at 0", async () => {
    const rt = createFakeRuntime()
    let schema: Record<string, unknown> = { type: "integer" }
    let value: unknown = 1
    for (let i = 0; i < 1000; i++) {
      schema = { type: "object", properties: { a: schema }, required: ["a"] }
      value = { a: value }
    }
    const deep = JSON.stringify(value)
    rt.turns.push(textTurn(deep), textTurn(deep), textTurn(deep), textTurn('{"n": 2}'))
    const h = await openExtSession(rt, ["usage", "structuredOutput"])
    const r = await h.prompt({ "minimal-agent/outputSchema": schema })
    expect(r.error).toBeUndefined()
    expect(r.result?.stopReason).toBe("end_turn")
    const err = meta(r)?.["minimal-agent/outputError"] as { message: string }
    expect(err.message).toContain("deeper than 64")
    const r2 = await h.prompt({ "minimal-agent/outputSchema": SCHEMA })
    expect(meta(r2)?.["minimal-agent/output"]).toEqual({ n: 2 })
    expect(meta(r2)?.["minimal-agent/usage"]).toEqual({ inputTokens: 3, outputTokens: 2 })
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("a failed retry run gives outputError with the first run's stopReason", async () => {
    const rt = createFakeRuntime()
    rt.turns.push(textTurn("not json"), {
      events: [],
      outcome: "failed",
      throws: new Error("blocked by turn.willStart hook"),
    })
    const h = await openExtSession(rt, ["usage", "structuredOutput"])
    const r = await h.prompt({ "minimal-agent/outputSchema": SCHEMA })
    expect(r.error).toBeUndefined()
    expect(rt.prompts.length).toBe(2)
    expect(r.result?.stopReason).toBe("end_turn")
    expect(meta(r)?.["minimal-agent/output"]).toBeUndefined()
    const err = meta(r)?.["minimal-agent/outputError"] as { message: string }
    expect(err.message).toBe("retry 1 failed: blocked by turn.willStart hook")
    // The next turn is clean.
    rt.turns.push(textTurn('{"n": 3}'))
    const r2 = await h.prompt({ "minimal-agent/outputSchema": SCHEMA })
    expect(meta(r2)?.["minimal-agent/output"]).toEqual({ n: 3 })
    expect(meta(r2)?.["minimal-agent/usage"]).toEqual({ inputTokens: 3, outputTokens: 2 })
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("a retry run that ends on a CoreError error event names the deny, never blank", async () => {
    const rt = createFakeRuntime()
    rt.turns.push(textTurn("not json"), {
      events: [
        {
          type: "error",
          message: "",
          error: {
            kind: "LifecycleDeniedError",
            fields: { hook: "tool.didBatch", reason: "budget spent" },
          },
        } as AgentEvent,
      ],
      outcome: "failed",
    })
    const h = await openExtSession(rt, ["usage", "structuredOutput"])
    const r = await h.prompt({ "minimal-agent/outputSchema": SCHEMA })
    const err = meta(r)?.["minimal-agent/outputError"] as { message: string }
    expect(err.message).toBe("retry 1 failed: tool.didBatch hook denied: budget spent")
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("feature not effective: no schema to run, no output keys", async () => {
    const rt = createFakeRuntime()
    rt.turns.push(textTurn('{"n": 4}'))
    const h = await openExtSession(rt, ["usage"])
    const r = await h.prompt({ "minimal-agent/outputSchema": SCHEMA })
    expect(rt.runOptions).toEqual([{ emitDeltas: true }])
    expect(meta(r)?.["minimal-agent/output"]).toBeUndefined()
    expect(meta(r)?.["minimal-agent/outputError"]).toBeUndefined()
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("answers -32602 for a schema that is not an object, and runs nothing", async () => {
    const rt = createFakeRuntime()
    const h = await openExtSession(rt, ["structuredOutput"])
    for (const bad of ["x", [1], null, 3]) {
      const r = await h.prompt({ "minimal-agent/outputSchema": bad })
      expect(r.error?.code).toBe(-32602)
    }
    expect(rt.runOptions).toEqual([])
    h.end()
    expect(await h.exit).toBe(0)
  })
})

describe("sampling (contract 5.f)", () => {
  it("passes temperature to run", async () => {
    const rt = createFakeRuntime()
    const h = await openExtSession(rt, ["sampling"])
    const r = await h.prompt({ "minimal-agent/sampling": { temperature: 0.2 } })
    expect(r.result?.stopReason).toBe("end_turn")
    expect(rt.runOptions).toEqual([{ emitDeltas: true, temperature: 0.2 }])
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("answers -32602 for a temperature that is not a finite number, or a non-object", async () => {
    const rt = createFakeRuntime()
    const h = await openExtSession(rt, ["sampling"])
    for (const bad of [{ temperature: "0.2" }, { temperature: null }, "hot", [0.2]]) {
      const r = await h.prompt({ "minimal-agent/sampling": bad })
      expect(r.error?.code).toBe(-32602)
    }
    expect(rt.runOptions).toEqual([])
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("feature not effective: no temperature to run", async () => {
    const rt = createFakeRuntime()
    const h = await openExtSession(rt, ["usage"])
    await h.prompt({ "minimal-agent/sampling": { temperature: 0.2 } })
    expect(rt.runOptions).toEqual([{ emitDeltas: true }])
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("an agent.temperature-ignored diag entry gives one notice per turn", async () => {
    const rt = createFakeRuntime()
    const ignored = { code: "agent.temperature-ignored" }
    rt.turns.push({ events: [], outcome: "completed", diags: [ignored, ignored] })
    const h = await openExtSession(rt, ["sampling"], true)
    const r = await h.prompt({ "minimal-agent/sampling": { temperature: 0.9 } })
    expect(r.result?.stopReason).toBe("end_turn")
    const notices = h
      .lines()
      .map((m) => m.params?.update)
      .filter((u) => u?.sessionUpdate === "notice")
    expect(notices).toEqual([
      {
        sessionUpdate: "notice",
        severity: "warning",
        title: "Temperature not applied",
        description: "The model does not accept temperature. The harness did not send 0.9.",
      },
    ])
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("a cache.anomaly diag gives one notice per anomaly code for the connection", async () => {
    const rt = createFakeRuntime()
    const cold = {
      code: "cache.anomaly",
      message:
        "cache: request had 2 cache_control marker(s) but the API returned 0 read + 0 write.",
      data: { code: "markers_ignored_cold" },
    }
    const evicted = {
      code: "cache.anomaly",
      message: "cache: evicted",
      data: { code: "cache_evicted" },
    }
    rt.turns.push({ events: [], outcome: "completed", diags: [cold, cold, { code: "other.code" }] })
    rt.turns.push({ events: [], outcome: "completed", diags: [cold, evicted] })
    const h = await openExtSession(rt, [], true)
    await h.prompt()
    await h.prompt()
    const notices = h
      .lines()
      .map((m) => m.params?.update)
      .filter((u) => u?.sessionUpdate === "notice")
    expect(notices).toEqual([
      {
        sessionUpdate: "notice",
        severity: "warning",
        title: "Prompt cache not used",
        description: cold.message,
      },
      {
        sessionUpdate: "notice",
        severity: "warning",
        title: "Prompt cache lost",
        description: "cache: evicted",
      },
    ])
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("without session.notices the diag notice falls back to answer text", async () => {
    const rt = createFakeRuntime()
    rt.turns.push({
      events: [],
      outcome: "completed",
      diags: [{ code: "agent.temperature-ignored" }, { code: "other.code" }],
    })
    const h = await openExtSession(rt, ["sampling"])
    await h.prompt({ "minimal-agent/sampling": { temperature: 0.9 } })
    const chunks = h
      .lines()
      .map((m) => m.params?.update)
      .filter((u) => u?.sessionUpdate === "agent_message_chunk")
    expect(chunks.length).toBe(1)
    expect(JSON.stringify(chunks[0])).toContain("does not accept temperature")
    h.end()
    expect(await h.exit).toBe(0)
  })
})
