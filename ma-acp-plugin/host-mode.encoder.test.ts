/**
 * In-process tests for the `host-mode.ts` wiring of the encoder: the real
 * handler, the real transport, a fake {@link HostRuntime} with scripted
 * turns, and in-memory stdio. Checks the protocol shape per request and
 * that every stdout line is a JSON-RPC 2.0 message.
 *
 * @module host-mode.encoder.test
 */

import { describe, expect, it } from "bun:test"

import type { HostModeContext } from "@minimal-agent/core/host-kit/host-mode"

import { createFakeRuntime, type FakeRuntime } from "./__fixtures__/fake-runtime.ts"
import handler from "./host-mode.ts"

interface Msg {
  readonly jsonrpc?: string
  readonly id?: number | null
  readonly method?: string
  readonly params?: { readonly update?: Record<string, unknown> }
  readonly result?: Record<string, unknown>
  readonly error?: { readonly code: number; readonly message: string }
}

function startHost(rt: FakeRuntime) {
  const queue: string[] = []
  let wake: (() => void) | undefined
  let ended = false
  const stdin = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as string
        if (ended) return
        await new Promise<void>((r) => {
          wake = r
        })
      }
    },
  }
  const out: string[] = []
  const noop = (): void => {}
  const ctx = {
    argv: [],
    stdin,
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: noop },
    abort: new AbortController().signal,
    cwd: "/work",
    env: {},
    log: { debug: noop, info: noop, warn: noop, error: noop },
    runtime: rt,
  } as unknown as HostModeContext
  const exit = handler(ctx)
  const lines = (): Msg[] =>
    out
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Msg)
  const send = (msg: unknown): void => {
    queue.push(`${JSON.stringify(msg)}\n`)
    wake?.()
  }
  const reply = async (id: number): Promise<Msg> => {
    for (let i = 0; i < 400; i++) {
      const hit = lines().find((m) => m.id === id && m.method === undefined)
      if (hit) return hit
      await Bun.sleep(5)
    }
    throw new Error(`no reply ${id}; stdout:\n${out.join("")}`)
  }
  const updates = (): Record<string, unknown>[] =>
    lines()
      .filter((m) => m.method === "session/update")
      .map((m) => m.params?.update ?? {})
  const end = async (): Promise<number> => {
    ended = true
    wake?.()
    return exit
  }
  return { send, reply, updates, lines, end, raw: out }
}

async function open(rt: FakeRuntime, clientCapabilities: Record<string, unknown> = {}) {
  const h = startHost(rt)
  h.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities },
  })
  await h.reply(1)
  h.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/work", mcpServers: [] } })
  const created = await h.reply(2)
  return { ...h, created, sessionId: created.result?.sessionId as string }
}

describe("host-mode encoder wiring", () => {
  it("session/new returns configOptions; set_config_option replies with the full list", async () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "medium" })
    const h = await open(rt)
    const opts = h.created.result?.configOptions as { id: string; currentValue: string }[]
    expect(opts.map((o) => [o.id, o.currentValue])).toEqual([
      ["model", "alpha"],
      ["effort", "medium"],
    ])

    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_config_option",
      params: { sessionId: h.sessionId, configId: "model", value: "gamma" },
    })
    const set = await h.reply(3)
    const after = set.result?.configOptions as { id: string; currentValue: string }[]
    expect(after.map((o) => [o.id, o.currentValue])).toEqual([
      ["model", "gamma"],
      ["effort", "high"], // medium reset to gamma's default
    ])

    h.send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/set_config_option",
      params: { sessionId: h.sessionId, configId: "effort", value: "medium" },
    })
    const bad = await h.reply(4)
    expect(bad.error?.code).toBe(-32602)
    expect([rt.model, rt.effort]).toEqual(["gamma", undefined])

    expect(await h.end()).toBe(0)
    expect(h.lines().every((m) => m.jsonrpc === "2.0")).toBe(true)
  })

  it("uses notice updates only when initialize advertised session.notices", async () => {
    const notice = {
      type: "notice",
      notice: { kind: "max_tokens_continuing", severity: "warn", attempt: 1, cap: 5 },
    }
    for (const [caps, expected] of [
      [{ session: { notices: {} } }, "notice"],
      [{}, "agent_message_chunk"],
    ] as const) {
      const rt = createFakeRuntime()
      rt.turns.push({ events: [notice as never], outcome: "completed" })
      const h = await open(rt, caps)
      h.send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: h.sessionId, prompt: [{ type: "text", text: "go" }] },
      })
      expect((await h.reply(3)).result).toEqual({ stopReason: "end_turn" })
      expect(h.updates()[0]?.sessionUpdate).toBe(expected)
      if (expected === "notice") expect(h.updates()[0]?.severity).toBe("warning")
      await h.end()
    }
  })

  it("streams a turn with tools, usage, model_adopted push, and the refined stop reason", async () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "medium" })
    rt.turns.push({
      before: (r) => r.setModel("gamma"),
      events: [
        {
          type: "notice",
          notice: {
            kind: "model_adopted",
            severity: "info",
            from: "alpha",
            to: "gamma",
            effortReset: true,
            effortFrom: "medium",
          },
        },
        { type: "text_delta", id: "m1", text: "ok" },
        {
          type: "tool_call",
          callId: "c1",
          toolName: "Bash",
          input: { command: "ls" },
          inputSummary: "ls",
        },
        { type: "status", phase: "running_tool", toolName: "Bash" },
        { type: "tool_result", id: "c1", name: "Bash", isError: false },
        {
          type: "turn_completed",
          turn: 1,
          stopReason: "context_window_exceeded",
          usage: { inputTokens: 7, outputTokens: 1, cacheReadTokens: 3 },
        },
      ],
      outcome: "completed",
    })
    const h = await open(rt, { session: { notices: {} } })
    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: h.sessionId, prompt: [{ type: "text", text: "go" }] },
    })
    const done = await h.reply(3)
    expect(done.result).toEqual({
      stopReason: "max_tokens",
      _meta: { "minimal-agent/stopReason": "context_window_exceeded" },
    })
    const kinds = h.updates().map((u) => u.sessionUpdate)
    expect(kinds).toEqual([
      "config_option_update",
      "notice",
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "tool_call_update",
      "usage_update",
      "notice", // "context window full"
    ])
    const push = h.updates()[0]?.configOptions as { id: string; currentValue: string }[]
    expect(push.map((o) => [o.id, o.currentValue])).toEqual([
      ["model", "gamma"],
      ["effort", "high"],
    ])
    expect(h.updates()[3]).toMatchObject({ kind: "execute", status: "pending" })
    expect(h.updates()[6]).toEqual({ sessionUpdate: "usage_update", used: 10, size: 1_000_000 })
    await h.end()
  })

  it("a failed turn sends its error text first, then a JSON-RPC error", async () => {
    const rt = createFakeRuntime()
    rt.turns.push({ events: [], outcome: "failed", throws: new Error("provider exploded") })
    const h = await open(rt)
    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: h.sessionId, prompt: [{ type: "text", text: "go" }] },
    })
    const done = await h.reply(3)
    expect(done.error).toEqual({ code: -32603, message: "provider exploded" })
    expect(JSON.stringify(h.updates())).toContain("provider exploded")
    await h.end()
  })

  it("a cancel answers cancelled even when the run throws, and the session takes a new turn", async () => {
    const rt = createFakeRuntime()
    rt.turns.push({
      events: [],
      outcome: "aborted",
      waitForAbort: true,
      throws: new Error("aborted"),
    })
    const h = await open(rt)
    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: h.sessionId, prompt: [{ type: "text", text: "go" }] },
    })
    await Bun.sleep(20)
    h.send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: { sessionId: h.sessionId, prompt: [{ type: "text", text: "again" }] },
    })
    expect((await h.reply(4)).error?.code).toBe(-32602) // a turn is already running
    h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: h.sessionId } })
    expect((await h.reply(3)).result).toEqual({ stopReason: "cancelled" })
    h.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/prompt",
      params: { sessionId: h.sessionId, prompt: [{ type: "text", text: "next" }] },
    })
    expect((await h.reply(5)).result).toEqual({ stopReason: "end_turn" })
    await h.end()
    expect(
      h.raw
        .join("")
        .split("\n")
        .filter(Boolean)
        .every((l) => JSON.parse(l).jsonrpc === "2.0"),
    ).toBe(true)
  })
})
