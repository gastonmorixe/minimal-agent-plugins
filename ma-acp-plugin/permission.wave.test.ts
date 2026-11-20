/**
 * The ACP approval gate with a wave of concurrency-safe tool calls
 * (announce before ask, spec D5). The test runs a real `AgentCore` (the
 * real tool round and wave scheduler) with concurrency cap 2. The
 * core events go through the real session encoder, and the real gate
 * hook (`createPermissionGate`) decides each admission.
 *
 * The e2e test (`acp-host.e2e.test.ts`) cannot reach a wave: the CLI does
 * not pass a concurrency cap to core yet (the default is 1), and its mock
 * model asks only for `Bash`, which is always a serial call. So this test
 * is at the nearest level: one process, the same core code path.
 *
 * @module permission.wave.test
 */

import { describe, expect, it } from "bun:test"

import { ToolFeedbackTracker } from "@minimal-agent/core/host-kit/feedback-tracker"
import type { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { ToolExecutorAdapter } from "@minimal-agent/core/host-kit/tool-executor-adapter"
import { AgentCore } from "@minimal-agent/core/sdk/agent-core"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"
import { type LifecyclePort, NOOP_LIFECYCLE } from "@minimal-agent/core/sdk/lifecycle"

import { createFakeRuntime } from "./__fixtures__/fake-runtime.ts"
import { createSessionEncoder } from "./encoder.ts"
import { NO_EXT } from "./ext.ts"
import { createPermissionGate } from "./permission.ts"

/** One line of the wire to the client: an update or a permission request. */
type WireItem =
  | { readonly kind: "update"; readonly update: Record<string, unknown> }
  | { readonly kind: "ask"; readonly toolCallId: string }

const LOOK_TOOL = {
  name: "Look",
  description: "Fake concurrency-safe tool.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
}

/**
 * The fake model: round 1 asks for 2 `Look` calls (`call_1`, `call_2`) in
 * one response, round 2 says "done".
 */
function twoCallModel() {
  let round = 0
  return async function* send(): AsyncGenerator<string, unknown, undefined> {
    round++
    if (round === 1) {
      return {
        blocks: [
          { type: "tool_use", id: "call_1", name: "Look", input: {} },
          { type: "tool_use", id: "call_2", name: "Look", input: {} },
        ],
        text: "",
        stopReason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 3 },
      }
    }
    yield "done"
    return {
      blocks: [{ type: "text", text: "done" }],
      text: "done",
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 3 },
    }
  }
}

/** Let all queued jobs run (the scheduler module loads on first use). */
async function flush(): Promise<void> {
  await Bun.sleep(50)
}

/**
 * A plugin loader with one concurrency-safe tool `Look`. Each run waits
 * until all `expected` runs started (or 500 ms), so a wave shows a peak
 * of 2 runs at the same time. A serial run never sees the second start.
 */
function waveLoader(expected: number) {
  let running = 0
  let started = 0
  const peak = { value: 0 }
  let allStarted = () => {}
  const allIn = new Promise<void>((res) => {
    allStarted = res
  })
  const loader = {
    hasTool: (name: string) => name === "Look",
    toolConcurrency: (name: string) => (name === "Look" ? { flag: true } : undefined),
    dispatch: async (trigger: { tool_use_id: string }) => {
      running++
      started++
      peak.value = Math.max(peak.value, running)
      if (started === expected) allStarted()
      await Promise.race([allIn, Bun.sleep(500)])
      running--
      return { kind: "tool_result" as const, content: `ok ${trigger.tool_use_id}`, is_error: false }
    },
    getExtraTools: () => [],
    getToolAliases: () => new Map<string, string>(),
  } as unknown as PluginLoader
  return { loader, peak }
}

describe("ACP approval gate inside a wave", () => {
  it("announce-before-ask with 2 calls: each ask follows its tool_call, asks come one at a time in call order", async () => {
    const wire: WireItem[] = []
    const encoder = createSessionEncoder({
      send: (update) => wire.push({ kind: "update", update }),
      clientNotices: false,
      runtime: createFakeRuntime(),
      cwd: "/work",
      ext: NO_EXT,
    })
    // The client answers each request by hand, so the test controls the time.
    const answers = new Map<string, () => void>()
    let open = 0
    let peakAsks = 0
    const gate = createPermissionGate({
      request: (_method, params) => {
        const toolCallId = (params as { toolCall: { toolCallId: string } }).toolCall.toolCallId
        wire.push({ kind: "ask", toolCallId })
        open++
        peakAsks = Math.max(peakAsks, open)
        return new Promise((res) => {
          answers.set(toolCallId, () => {
            open--
            res({ outcome: { outcome: "selected", optionId: "allow_once" } })
          })
        })
      },
      sessionId: () => "s1",
      // The same wait as host-mode.ts: send the tool_call update first.
      beforeRequest: (payload) => encoder.toolCallSent(payload.toolUseId, 1000),
    })
    // The core side of the failClosed `tool.willInvoke` hook (permission-hook.ts).
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      hasFailClosedToolHook: () => true,
      async beforeTool(payload) {
        const result = await gate.check(payload)
        return result === undefined
          ? { action: "allow" as const, payload }
          : { action: "deny" as const, reason: result.reason }
      },
    }
    const { loader, peak } = waveLoader(2)
    const toolResults: { id: string; isError: boolean }[] = []
    const core = new AgentCore({
      auth: { type: "api-key", token: "test-token" },
      model: "test-model",
      systemPrompt: "You are a test agent.",
      maxTokens: 1024,
      toolRegistry: { list: () => [LOOK_TOOL] },
      toolExecutor: new ToolExecutorAdapter({
        loader,
        modeManager: null,
        blobStore: null,
        blobSkipTools: new Set(),
        feedbackTracker: new ToolFeedbackTracker(),
        model: "test-model",
        lifecycle,
      }),
      sendFn: twoCallModel(),
      // The ACP host sends each core event to the encoder as it comes.
      eventSink: {
        emit: (event: AgentEvent) => {
          encoder.encode(event)
          if (event.type === "tool_result") {
            toolResults.push({ id: event.id, isError: event.isError })
          }
        },
      },
      maxConcurrentToolCalls: 2,
    } as never)
    const done = (async () => {
      for await (const _ of core.run("go")) {
        // drain
      }
    })()

    await flush()
    // Only call 1 is announced and asked. Call 2 waits for its admission.
    const asks = () => wire.flatMap((w) => (w.kind === "ask" ? [w.toolCallId] : []))
    expect(asks()).toEqual(["call_1"])
    answers.get("call_1")?.()
    await flush()
    expect(asks()).toEqual(["call_1", "call_2"])
    answers.get("call_2")?.()
    await done

    // Both calls ran; the results come in call order.
    expect(toolResults).toEqual([
      { id: "call_1", isError: false },
      { id: "call_2", isError: false },
    ])
    // The two runs overlapped: the calls ran as one wave.
    expect(peak.value).toBe(2)
    // The asks came one at a time.
    expect(peakAsks).toBe(1)
    // Each ask comes after the tool_call update of that id.
    const at = (pred: (w: WireItem) => boolean): number => wire.findIndex(pred)
    for (const id of ["call_1", "call_2"]) {
      const announced = at(
        (w) =>
          w.kind === "update" &&
          w.update.sessionUpdate === "tool_call" &&
          w.update.toolCallId === id,
      )
      const asked = at((w) => w.kind === "ask" && w.toolCallId === id)
      expect(announced).toBeGreaterThanOrEqual(0)
      expect(announced).toBeLessThan(asked)
    }
    // Call order of the asks and of the tool_call updates.
    expect(at((w) => w.kind === "ask" && w.toolCallId === "call_1")).toBeLessThan(
      at((w) => w.kind === "ask" && w.toolCallId === "call_2"),
    )
  })
})
