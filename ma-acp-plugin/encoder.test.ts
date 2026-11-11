import { describe, expect, it } from "bun:test"

import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import { createFakeRuntime } from "./__fixtures__/fake-runtime.ts"
import { createSessionEncoder, toAcpToolKind, toAcpToolStatus, toolLocations } from "./encoder.ts"
import { type ExtAdvert, NO_EXT } from "./ext.ts"

type Update = Record<string, unknown>

function setup(
  opts: { clientNotices?: boolean; model?: string; effort?: string; ext?: ExtAdvert } = {},
) {
  const rt = createFakeRuntime({ model: opts.model ?? "alpha", effort: opts.effort })
  const sent: Update[] = []
  const enc = createSessionEncoder({
    send: (u) => sent.push(u),
    clientNotices: opts.clientNotices ?? false,
    runtime: rt,
    cwd: "/work",
    ext: opts.ext ?? NO_EXT,
  })
  const feed = (...events: AgentEvent[]): void => {
    for (const e of events) enc.encode(e)
  }
  return { rt, sent, enc, feed }
}

const usage = (inputTokens: number, cacheReadTokens?: number, cacheCreationTokens?: number) => ({
  inputTokens,
  outputTokens: 999,
  ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
  ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
})

describe("message chunks", () => {
  it("maps text and thinking deltas", () => {
    const { sent, feed } = setup()
    feed(
      { type: "text_delta", id: "m1", text: "hi" },
      { type: "thinking_delta", id: "t1", text: "hm" },
    )
    expect(sent).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { type: "text", text: "hi" },
      },
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "t1",
        content: { type: "text", text: "hm" },
      },
    ])
  })
})

describe("tool updates (design section 6)", () => {
  it("maps neutral categories to ACP kinds (run -> execute)", () => {
    expect(toAcpToolKind("run")).toBe("execute")
    for (const c of [
      "read",
      "edit",
      "delete",
      "move",
      "search",
      "fetch",
      "think",
      "other",
    ] as const) {
      expect(toAcpToolKind(c)).toBe(c)
    }
  })

  it("maps neutral statuses to ACP statuses (denied -> failed)", () => {
    expect(toAcpToolStatus("pending")).toBe("pending")
    expect(toAcpToolStatus("running")).toBe("in_progress")
    expect(toAcpToolStatus("succeeded")).toBe("completed")
    expect(toAcpToolStatus("failed")).toBe("failed")
    expect(toAcpToolStatus("denied")).toBe("failed")
  })

  it.each([
    ["Read", "read"],
    ["Write", "edit"],
    ["Edit", "edit"],
    ["Bash", "execute"],
    ["Glob", "search"],
    ["Grep", "search"],
    ["Fetch", "fetch"],
    ["WebSearch", "fetch"],
    ["Task", "think"],
    ["Skill", "other"],
    ["SomePluginTool", "other"],
  ])("tool_call %s has kind %s and status pending", (toolName, kind) => {
    const { sent, feed } = setup()
    feed({ type: "tool_call", callId: "c1", toolName, input: {}, inputSummary: "" })
    expect(sent[0]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      kind,
      status: "pending",
    })
  })

  it("runs a tool call through pending, in_progress, output, completed", () => {
    const { sent, feed } = setup()
    feed(
      {
        type: "tool_call",
        callId: "c1",
        toolName: "Read",
        input: { file_path: "src/a.ts", offset: 10 },
        inputSummary: "src/a.ts",
      },
      { type: "status", phase: "running_tool", toolName: "Read" },
      {
        type: "tool_output",
        callId: "c1",
        toolName: "Read",
        text: "body",
        truncated: false,
        totalBytes: 4,
      },
      { type: "tool_result", id: "c1", name: "Read", isError: false },
    )
    expect(sent).toEqual([
      {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "Read: src/a.ts",
        kind: "read",
        status: "pending",
        rawInput: { file_path: "src/a.ts", offset: 10 },
        locations: [{ path: "/work/src/a.ts", line: 10 }],
      },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        content: [{ type: "content", content: { type: "text", text: "body" } }],
      },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" },
    ])
  })

  it("marks an error result failed and flags capped output in _meta", () => {
    const { sent, feed } = setup()
    feed(
      {
        type: "tool_output",
        callId: "c2",
        toolName: "Bash",
        text: "x",
        truncated: true,
        totalBytes: 99_999,
      },
      { type: "tool_result", id: "c2", name: "Bash", isError: true },
    )
    expect(sent[0]?._meta).toEqual({
      "minimal-agent/truncated": true,
      "minimal-agent/totalBytes": 99_999,
    })
    expect(sent[1]).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "c2",
      status: "failed",
    })
  })

  it("sends no in_progress update for a running_tool status with no open tool call", () => {
    const { sent, feed } = setup()
    feed(
      { type: "status", phase: "running_tool", toolName: "Bash" },
      { type: "status", phase: "sending" },
    )
    expect(sent).toEqual([])
  })

  it("marks each open tool call in_progress once when tool calls overlap", () => {
    const { sent, feed } = setup()
    const call = (callId: string, toolName: string): AgentEvent => ({
      type: "tool_call",
      callId,
      toolName,
      input: {},
      inputSummary: "",
    })
    feed(
      call("c1", "Bash"),
      call("c2", "Grep"),
      call("c3", "Bash"),
      { type: "status", phase: "running_tool", toolName: "Grep" },
      { type: "status", phase: "running_tool", toolName: "Bash" },
      { type: "status", phase: "running_tool", toolName: "Bash" },
      { type: "status", phase: "running_tool", toolName: "Bash" },
      { type: "tool_result", id: "c2", name: "Grep", isError: false },
    )
    const running = sent
      .filter((u) => u.status === "in_progress")
      .map((u) => u.toolCallId as string)
    expect(running).toEqual(["c2", "c1", "c3"])
    expect(sent.at(-1)).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "c2",
      status: "completed",
    })
  })

  it("derives locations for file tools only", () => {
    expect(toolLocations("Write", { file_path: "/abs/x" }, "/w")).toEqual([{ path: "/abs/x" }])
    expect(toolLocations("Edit", { file_path: "y" }, "/w")).toEqual([{ path: "/w/y" }])
    expect(toolLocations("Glob", { pattern: "*", target_directory: "d" }, "/w")).toEqual([
      { path: "/w/d" },
    ])
    expect(toolLocations("Grep", { pattern: "x", path: "/p" }, "/w")).toEqual([{ path: "/p" }])
    expect(toolLocations("Grep", { pattern: "x" }, "/w")).toEqual([])
    expect(toolLocations("Bash", { command: "ls" }, "/w")).toEqual([])
    expect(toolLocations("Read", { file_path: 3 }, "/w")).toEqual([])
  })
})

describe("toolCallSent", () => {
  const call = (callId: string): AgentEvent => ({
    type: "tool_call",
    callId,
    toolName: "Bash",
    input: { command: "ls" },
    inputSummary: "ls",
  })

  it("resolves at once when the tool_call update is sent already", async () => {
    const { enc, feed } = setup()
    feed(call("c1"))
    const r = await Promise.race([enc.toolCallSent("c1", 5000).then(() => "sent"), Bun.sleep(50)])
    expect(r).toBe("sent")
  })

  it("resolves when the tool_call update is sent later", async () => {
    const { enc, feed, sent } = setup()
    const order: string[] = []
    const wait = enc.toolCallSent("c2", 5000).then(() => {
      order.push(`resolved after ${sent.length} update(s)`)
    })
    await Bun.sleep(5)
    expect(order).toEqual([])
    feed(call("c2"))
    await wait
    expect(order).toEqual(["resolved after 1 update(s)"])
  })

  it("resolves after the timeout when no tool_call update comes", async () => {
    const { enc } = setup()
    const t0 = Date.now()
    await enc.toolCallSent("never", 20)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15)
  })
})

describe("usage_update (design section 7)", () => {
  it("used = input + cacheRead + cacheCreation of the LAST turn; size = contextWindow", () => {
    const { sent, feed } = setup({ model: "alpha" })
    feed({ type: "turn_completed", turn: 1, stopReason: "end_turn", usage: usage(100, 20, 3) })
    feed({ type: "turn_completed", turn: 2, stopReason: "end_turn", usage: usage(50) })
    expect(sent).toEqual([
      { sessionUpdate: "usage_update", used: 123, size: 200_000 },
      // a proxy for the current context, never a sum across turns
      { sessionUpdate: "usage_update", used: 50, size: 200_000 },
    ])
    expect(sent.every((u) => !("cost" in u))).toBe(true)
  })

  it("reads size from the live model", () => {
    const { rt, sent, feed } = setup({ model: "alpha" })
    rt.setModel("gamma")
    feed({ type: "turn_completed", turn: 1, stopReason: "end_turn", usage: usage(10) })
    expect(sent[0]).toMatchObject({ size: 1_000_000 })
  })

  it("sends no usage_update when the model's window is unknown", () => {
    const { sent, feed } = setup({ model: "custom-x" })
    feed({ type: "turn_completed", turn: 1, stopReason: "end_turn", usage: usage(10) })
    expect(sent).toEqual([])
  })
})

describe("notices", () => {
  const warn: AgentEvent = {
    type: "notice",
    notice: { kind: "max_tokens_continuing", severity: "warn", attempt: 1, cap: 5 },
  }

  it("sends a notice update with ACP severity when the client supports notices", () => {
    const { sent, feed } = setup({ clientNotices: true })
    feed(warn)
    expect(sent[0]).toMatchObject({ sessionUpdate: "notice", severity: "warning" })
  })

  it("falls back to agent_message_chunk with a distinct messageId per notice", () => {
    const { sent, feed } = setup({ clientNotices: false })
    feed(warn, warn)
    expect(sent.map((u) => u.sessionUpdate)).toEqual(["agent_message_chunk", "agent_message_chunk"])
    expect(sent[0]?.messageId).not.toBe(sent[1]?.messageId)
  })
})

describe("model_adopted (spec Q16 item 3)", () => {
  const adopted = (from: string, to: string, effortFrom: string | null): AgentEvent => ({
    type: "notice",
    notice: {
      kind: "model_adopted",
      severity: "info",
      from,
      to,
      effortReset: effortFrom !== null,
      effortFrom,
    },
  })

  it("pushes config_option_update with the new model and the reset effort, then the notice", () => {
    const { rt, sent, feed } = setup({ model: "alpha", effort: "medium", clientNotices: true })
    rt.setModel("gamma") // core adopts first, resetting medium -> undefined
    feed(adopted("alpha", "gamma", "medium"))
    expect(sent[0]?.sessionUpdate).toBe("config_option_update")
    const opts = sent[0]?.configOptions as { id: string; currentValue: string }[]
    expect(opts.find((o) => o.id === "model")?.currentValue).toBe("gamma")
    expect(opts.find((o) => o.id === "effort")?.currentValue).toBe("high")
    expect(sent[1]).toMatchObject({
      sessionUpdate: "notice",
      severity: "info",
      title: "Model changed",
    })
  })

  it("pushes config_option_update every time, even without an effort reset", () => {
    const { rt, sent, feed } = setup({ model: "alpha" })
    rt.setModel("gamma")
    feed(adopted("alpha", "gamma", null))
    rt.setModel("alpha")
    feed(adopted("gamma", "alpha", null))
    const pushes = sent.filter((u) => u.sessionUpdate === "config_option_update")
    expect(pushes.length).toBe(2)
  })
})

describe("model_adopt_failed", () => {
  it("sends a warning notice and no config_option_update", () => {
    const { sent, feed } = setup({ model: "alpha", clientNotices: true })
    feed({
      type: "notice",
      notice: {
        kind: "model_adopt_failed",
        severity: "warn",
        model: "alpha",
        requested: "zeta",
        reason: "unknown model",
      },
    })
    expect(sent.some((u) => u.sessionUpdate === "config_option_update")).toBe(false)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      sessionUpdate: "notice",
      severity: "warning",
      title: "Model not changed",
    })
  })
})

describe("finishTurn", () => {
  it("answers end_turn from the last turn_completed and resets for the next turn", () => {
    const { enc, feed } = setup()
    feed({ type: "turn_completed", turn: 1, stopReason: "refusal", usage: usage(1) })
    expect(enc.finishTurn("completed")).toEqual({
      kind: "reply",
      result: {
        stopReason: "refusal",
        usage: { totalTokens: 1000, inputTokens: 1, outputTokens: 999 },
      },
    })
    // next turn: no turn_completed, no notice -> end_turn, not a stale refusal
    expect(enc.finishTurn("completed")).toEqual({
      kind: "reply",
      result: {
        stopReason: "end_turn",
        usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
      },
    })
  })

  it("adds _meta and a notice for pause_turn", () => {
    const { enc, sent, feed } = setup({ clientNotices: true })
    feed({ type: "turn_completed", turn: 1, stopReason: "pause_turn", usage: usage(1) })
    sent.length = 0
    expect(enc.finishTurn("completed")).toEqual({
      kind: "reply",
      result: {
        stopReason: "end_turn",
        usage: { totalTokens: 1000, inputTokens: 1, outputTokens: 999 },
        _meta: { "minimal-agent/stopReason": "pause_turn" },
      },
    })
    expect(sent[0]).toMatchObject({ sessionUpdate: "notice", severity: "warning" })
  })

  it("uses the capped notice for a truncated turn", () => {
    const { enc, feed } = setup()
    feed({ type: "notice", notice: { kind: "max_tokens_capped", severity: "warn", cap: 5 } })
    expect(enc.finishTurn("truncated")).toEqual({
      kind: "reply",
      result: {
        stopReason: "max_tokens",
        usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
      },
    })
  })

  it("sends the error text before a failed turn's JSON-RPC error", () => {
    const { enc, sent, feed } = setup({ clientNotices: false })
    feed({ type: "error", message: "provider exploded" })
    const reply = enc.finishTurn("waiting")
    expect(reply).toEqual({ kind: "error", code: -32603, message: "provider exploded" })
    expect(sent[0]?.sessionUpdate).toBe("agent_message_chunk")
    expect(JSON.stringify(sent[0])).toContain("provider exploded")
  })
})

describe("prompt usage (M1, docs/acp-extensions.md section 5.a)", () => {
  const USAGE_EXT: ExtAdvert = { version: 1, features: ["usage"] }
  const round = (
    turn: number,
    u: { input: number; output: number; read?: number; write?: number },
    stopReason: "end_turn" | "tool_use" | "pause_turn" = "tool_use",
  ): AgentEvent => ({
    type: "turn_completed",
    turn,
    stopReason,
    usage: {
      inputTokens: u.input,
      outputTokens: u.output,
      ...(u.read === undefined ? {} : { cacheReadTokens: u.read }),
      ...(u.write === undefined ? {} : { cacheCreationTokens: u.write }),
    },
  })

  it("sums every round of the prompt into the standard usage", () => {
    const { enc, feed } = setup()
    feed(round(1, { input: 100, output: 20, read: 1000, write: 50 }))
    feed(round(2, { input: 10, output: 5, read: 1100 }, "end_turn"))
    expect(enc.finishTurn("completed")).toEqual({
      kind: "reply",
      result: {
        stopReason: "end_turn",
        usage: {
          totalTokens: 2285,
          inputTokens: 2260, // 110 uncached + 2100 read + 50 write
          outputTokens: 25,
          cachedReadTokens: 2100,
          cachedWriteTokens: 50,
        },
      },
    })
  })

  it("adds _meta minimal-agent/usage with uncached input when usage is effective", () => {
    const { enc, feed } = setup({ ext: USAGE_EXT })
    feed(round(1, { input: 100, output: 20, read: 1000, write: 50 }))
    feed(round(2, { input: 10, output: 5, read: 1100 }, "end_turn"))
    const reply = enc.finishTurn("completed")
    expect(reply).toMatchObject({ kind: "reply", result: { usage: { inputTokens: 2260 } } })
    if (reply.kind !== "reply") throw new Error("expected a reply")
    expect(reply.result._meta).toEqual({
      "minimal-agent/usage": {
        inputTokens: 110,
        outputTokens: 25,
        cacheReadTokens: 2100,
        cacheWriteTokens: 50,
      },
    })
  })

  it("omits cache fields that no round reported (not reported, not zero)", () => {
    const { enc, feed } = setup({ ext: USAGE_EXT })
    feed(round(1, { input: 7, output: 3 }, "end_turn"))
    expect(enc.finishTurn("completed")).toEqual({
      kind: "reply",
      result: {
        stopReason: "end_turn",
        usage: { totalTokens: 10, inputTokens: 7, outputTokens: 3 },
        _meta: { "minimal-agent/usage": { inputTokens: 7, outputTokens: 3 } },
      },
    })
  })

  it("sends no minimal-agent/usage key without the feature, other _meta unchanged", () => {
    const { enc, feed } = setup({ ext: { version: 1, features: [] } })
    feed(round(1, { input: 4, output: 2 }, "pause_turn"))
    expect(enc.finishTurn("completed")).toEqual({
      kind: "reply",
      result: {
        stopReason: "end_turn",
        usage: { totalTokens: 6, inputTokens: 4, outputTokens: 2 },
        _meta: { "minimal-agent/stopReason": "pause_turn" },
      },
    })
  })

  it("keeps other _meta keys beside minimal-agent/usage", () => {
    const { enc, feed } = setup({ ext: USAGE_EXT })
    feed(round(1, { input: 4, output: 2 }, "pause_turn"))
    const reply = enc.finishTurn("completed")
    if (reply.kind !== "reply") throw new Error("expected a reply")
    expect(reply.result._meta).toEqual({
      "minimal-agent/stopReason": "pause_turn",
      "minimal-agent/usage": { inputTokens: 4, outputTokens: 2 },
    })
  })

  it("resets the counters after each reply (never cumulative)", () => {
    const { enc, feed } = setup({ ext: USAGE_EXT })
    feed(round(1, { input: 100, output: 20, read: 5 }, "end_turn"))
    enc.finishTurn("completed")
    feed(round(1, { input: 3, output: 1 }, "end_turn"))
    expect(enc.finishTurn("completed")).toEqual({
      kind: "reply",
      result: {
        stopReason: "end_turn",
        usage: { totalTokens: 4, inputTokens: 3, outputTokens: 1 },
        _meta: { "minimal-agent/usage": { inputTokens: 3, outputTokens: 1 } },
      },
    })
  })

  it("sends what was counted so far on a cancelled reply", () => {
    const { enc, feed } = setup({ ext: USAGE_EXT })
    feed(round(1, { input: 9, output: 4, read: 2 }))
    expect(enc.finishTurn("aborted")).toEqual({
      kind: "reply",
      result: {
        stopReason: "cancelled",
        usage: { totalTokens: 15, inputTokens: 11, outputTokens: 4, cachedReadTokens: 2 },
        _meta: { "minimal-agent/usage": { inputTokens: 9, outputTokens: 4, cacheReadTokens: 2 } },
      },
    })
  })

  it("resets the counters after an error reply too", () => {
    const { enc, feed } = setup({ ext: USAGE_EXT })
    feed(round(1, { input: 50, output: 5 }))
    feed({ type: "error", message: "provider exploded" })
    expect(enc.finishTurn("waiting")).toMatchObject({ kind: "error" })
    feed(round(1, { input: 1, output: 1 }, "end_turn"))
    expect(enc.finishTurn("completed")).toMatchObject({
      kind: "reply",
      result: {
        usage: { totalTokens: 2, inputTokens: 1, outputTokens: 1 },
        _meta: { "minimal-agent/usage": { inputTokens: 1, outputTokens: 1 } },
      },
    })
  })

  it("leaves the usage_update gauge unchanged", () => {
    const { sent, feed } = setup({ model: "alpha", ext: USAGE_EXT })
    feed(round(1, { input: 100, output: 20, read: 20, write: 3 }))
    feed(round(2, { input: 50, output: 1 }))
    expect(sent).toEqual([
      { sessionUpdate: "usage_update", used: 123, size: 200_000 },
      { sessionUpdate: "usage_update", used: 50, size: 200_000 },
    ])
  })
})
