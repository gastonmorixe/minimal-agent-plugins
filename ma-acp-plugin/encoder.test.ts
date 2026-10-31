import { describe, expect, it } from "bun:test"

import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import { createFakeRuntime } from "./__fixtures__/fake-runtime.ts"
import { createSessionEncoder, toAcpToolKind, toAcpToolStatus, toolLocations } from "./encoder.ts"

type Update = Record<string, unknown>

function setup(opts: { clientNotices?: boolean; model?: string; effort?: string } = {}) {
  const rt = createFakeRuntime({ model: opts.model ?? "alpha", effort: opts.effort })
  const sent: Update[] = []
  const enc = createSessionEncoder({
    send: (u) => sent.push(u),
    clientNotices: opts.clientNotices ?? false,
    runtime: rt,
    cwd: "/work",
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
      result: { stopReason: "refusal" },
    })
    // next turn: no turn_completed, no notice -> end_turn, not a stale refusal
    expect(enc.finishTurn("completed")).toEqual({
      kind: "reply",
      result: { stopReason: "end_turn" },
    })
  })

  it("adds _meta and a notice for pause_turn", () => {
    const { enc, sent, feed } = setup({ clientNotices: true })
    feed({ type: "turn_completed", turn: 1, stopReason: "pause_turn", usage: usage(1) })
    sent.length = 0
    expect(enc.finishTurn("completed")).toEqual({
      kind: "reply",
      result: { stopReason: "end_turn", _meta: { "minimal-agent/stopReason": "pause_turn" } },
    })
    expect(sent[0]).toMatchObject({ sessionUpdate: "notice", severity: "warning" })
  })

  it("uses the capped notice for a truncated turn", () => {
    const { enc, feed } = setup()
    feed({ type: "notice", notice: { kind: "max_tokens_capped", severity: "warn", cap: 5 } })
    expect(enc.finishTurn("truncated")).toEqual({
      kind: "reply",
      result: { stopReason: "max_tokens" },
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
