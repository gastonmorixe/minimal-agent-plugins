/**
 * Offline: a Cursor request with no tools (context compaction, titles, summaries)
 * must use the bidi wire too. The server sends KvServerMessage set_blob and waits
 * for the ack before turn_ended. The unary path cannot answer, so tool-less turns
 * hung until the host watchdog (live 2026-09-28, stuck compaction).
 *
 * A tool-less run must also not close an open tool session that shares the same
 * host session id (a pending exec waiting for its tool_result).
 */

import { afterEach, describe, expect, test } from "bun:test"

import { cursorAdapter } from "./adapter.ts"
import { runCursorBidi, shouldUseCursorBidi } from "./bidi-run.ts"
import { cursorCaps } from "./capabilities.ts"
import { connectFrameProto, parseConnectFrames } from "./connect/stream.ts"
import { resetCursorBidiSessionsForTests } from "./cursor-bidi-session.ts"
import { CURSOR_ALLOWED_TOOLS_HEADER, CURSOR_EXCLUDE_TOOLS_HEADER } from "./cursor-tool-policy.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { NetworkClient, NetworkRequestInput, NetworkResponse } from "./lib/net-types.ts"
import type { ProviderAuth, RunContext } from "./lib/provider-auth.ts"
import {
  concat,
  decodeFields,
  encBytes,
  encMsg,
  encString,
  encVarintField,
  getFirstMsg,
  getRepeatedMsg,
} from "./proto/wire.ts"
import { CURSOR_STREAM_CONTENT_TYPE, CURSOR_SURFACE_AGENT_RUN } from "./wire-constants.ts"

const model = {
  id: "cursor-auto",
  providerId: "cursor",
  surfaceId: CURSOR_SURFACE_AGENT_RUN,
  displayName: "Auto",
  capabilities: cursorCaps(),
  pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0, webSearchPerCallUSD: 0 },
  vendorIds: { cursor: "default" },
}

const auth: ProviderAuth = { kind: "custom", headers: { authorization: "Bearer test-redacted" } }

const toollessReq: CanonicalRequest = {
  modelId: "cursor-auto",
  messages: [{ role: "user", content: [{ type: "text", text: "summarize" }] }],
}

const toolsReq: CanonicalRequest = {
  modelId: "cursor-auto",
  messages: [{ role: "user", content: [{ type: "text", text: "call ModelInfo" }] }],
  tools: [{ name: "ModelInfo", description: "meta", inputSchema: { type: "object" } }],
}

const textFrame = (t: string) => connectFrameProto(encMsg(1, encMsg(1, encString(1, t))))
const turnEndedFrame = () => connectFrameProto(encMsg(1, encMsg(14, new Uint8Array(0))))
const kvSetFrame = (id: number) =>
  connectFrameProto(
    encMsg(
      4,
      concat(
        encVarintField(1, id),
        encMsg(3, concat(encBytes(1, new Uint8Array([1])), encBytes(2, new Uint8Array([2])))),
      ),
    ),
  )
const mcpExecFrame = (id: number, toolCallId: string) =>
  connectFrameProto(
    encMsg(
      2,
      concat(
        encVarintField(1, id),
        encMsg(
          11,
          concat(
            encString(3, toolCallId),
            encString(4, "minimal-agent"),
            encString(5, "ModelInfo"),
          ),
        ),
      ),
    ),
  )
const mcpStateFrame = () => connectFrameProto(encMsg(2, encMsg(36, encString(1, "minimal-agent"))))

/** Top-level AgentClientMessage field numbers written in one chunk. */
function writtenFields(chunk: Uint8Array): number[] {
  return parseConnectFrames(chunk).flatMap((f) => decodeFields(f.payload).map((x) => x.no))
}

type Wire = {
  ctrl?: ReadableStreamDefaultController<Uint8Array>
  writes: Uint8Array[]
}

/** Fake client: each request() gets its own wire, driven by `script(wireIndex, wire)`. */
function scriptedClient(
  onOpen: (index: number, wire: Wire) => void,
  onWrite: (index: number, wire: Wire, chunk: Uint8Array) => void,
): { client: NetworkClient; calls: NetworkRequestInput[]; wires: Wire[] } {
  const calls: NetworkRequestInput[] = []
  const wires: Wire[] = []
  const client: NetworkClient = {
    request(input: NetworkRequestInput): Promise<NetworkResponse> {
      calls.push(input)
      const index = wires.length
      const wire: Wire = { writes: [] }
      wires.push(wire)
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          wire.ctrl = c
          onOpen(index, wire)
        },
      })
      return Promise.resolve({
        status: 200,
        headers: new Headers({ "content-type": CURSOR_STREAM_CONTENT_TYPE }),
        body,
        transport: { id: "fake-h2", protocol: "h2" },
        ok: true,
        text: async () => "",
        json: async <T>() => ({}) as T,
        writeRequestBody(chunk: Uint8Array) {
          wire.writes.push(chunk)
          onWrite(index, wire, chunk)
        },
        endRequestBody() {},
      } satisfies NetworkResponse)
    },
  }
  return { client, calls, wires }
}

function headerOf(input: NetworkRequestInput, name: string): string | undefined {
  return Object.entries(input.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1]
}

async function collect(
  gen: AsyncIterable<CanonicalEvent>,
  label: string,
  ms = 2000,
): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = []
  const run = (async () => {
    for await (const ev of gen) out.push(ev)
  })()
  await Promise.race([
    run,
    new Promise<never>((_, r) => setTimeout(() => r(new Error(`hung: ${label}`)), ms)),
  ])
  return out
}

const textOf = (evs: CanonicalEvent[]) =>
  evs
    .filter((e): e is Extract<CanonicalEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("")

describe("cursor tool-less requests use the bidi wire", () => {
  afterEach(() => {
    delete process.env.MA_CURSOR_BIDI_HEARTBEAT_MS
    delete process.env.MA_CURSOR_BIDI
    resetCursorBidiSessionsForTests()
  })

  test("shouldUseCursorBidi: on with a network client, tools or not", () => {
    const client = { request: async () => ({}) as never } as NetworkClient
    expect(shouldUseCursorBidi(toollessReq, client)).toBe(true)
    expect(shouldUseCursorBidi(toolsReq, client)).toBe(true)
    expect(shouldUseCursorBidi(toollessReq, undefined)).toBe(false)
    process.env.MA_CURSOR_BIDI = "0"
    expect(shouldUseCursorBidi(toollessReq, client)).toBe(false)
  })

  test("adapter: tool-less turn answers KV set_blob and ends (was a hang)", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    const { client, calls } = scriptedClient(
      (_i, w) => {
        w.ctrl?.enqueue(textFrame("SUMMARY"))
        w.ctrl?.enqueue(kvSetFrame(4))
      },
      (_i, w, chunk) => {
        // The server sends turn_ended only after the KV ack (AgentClientMessage #3).
        if (writtenFields(chunk).includes(3) && w.ctrl) {
          w.ctrl.enqueue(turnEndedFrame())
          w.ctrl.close()
          w.ctrl = undefined
        }
      },
    )
    const ctx: RunContext = { auth, sessionId: "toolless-kv", networkClient: client }
    const events = await collect(cursorAdapter.run(toollessReq, model as never, ctx), "kv ack")

    expect(textOf(events)).toBe("SUMMARY")
    expect(events.some((e) => e.type === "message_stop")).toBe(true)
    expect(events.some((e) => e.type === "stream_error")).toBe(false)
    // Tools off keeps the exclude list (mcp_tool_call included) and no allowlist.
    expect(calls).toHaveLength(1)
    expect(headerOf(calls[0]!, CURSOR_ALLOWED_TOOLS_HEADER)).toBeUndefined()
    expect(headerOf(calls[0]!, CURSOR_EXCLUDE_TOOLS_HEADER)?.split(",")).toContain("mcp_tool_call")
  })

  test("a tool-less run does not close a pending tool session on the same host id", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    const { client, calls, wires } = scriptedClient(
      (i, w) => {
        if (i === 0) w.ctrl?.enqueue(mcpExecFrame(1, "call-1"))
        if (i === 1) {
          w.ctrl?.enqueue(textFrame("SIDE"))
          w.ctrl?.enqueue(turnEndedFrame())
          w.ctrl?.close()
        }
      },
      (i, w, chunk) => {
        // Wire 0: after the tool result (exec_client_message #2) the turn ends.
        if (i === 0 && writtenFields(chunk).includes(2) && w.ctrl) {
          w.ctrl.enqueue(textFrame("GOT-TOOL"))
          w.ctrl.enqueue(turnEndedFrame())
          w.ctrl.close()
          w.ctrl = undefined
        }
      },
    )
    const opts = {
      url: "https://example.test/agent.v1.AgentService/Run",
      headers: {},
      initialRunBody: new Uint8Array([0]),
      sessionId: "shared-host-session",
      modelId: "cursor-auto",
      networkClient: client,
    }

    const gen1 = await collect(runCursorBidi(toolsReq, model as never, opts), "gen1")
    expect(gen1.some((e) => e.type === "tool_use_start")).toBe(true)

    const side = await collect(runCursorBidi(toollessReq, model as never, opts), "side run")
    expect(textOf(side)).toBe("SIDE")

    const continuation: CanonicalRequest = {
      ...toolsReq,
      messages: [
        ...toolsReq.messages,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "ModelInfo", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "call-1", content: [{ type: "text", text: "{}" }] },
          ],
        },
      ],
    }
    const gen2 = await collect(runCursorBidi(continuation, model as never, opts), "continuation")

    // The continuation reused wire 0: only two requests were ever opened.
    expect(calls).toHaveLength(2)
    expect(wires[0]!.writes.some((c) => writtenFields(c).includes(2))).toBe(true)
    expect(textOf(gen2)).toBe("GOT-TOOL")
  })

  test("mcp_state on a tool-less run is answered with an empty server list", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    let reply: Uint8Array | undefined
    const { client } = scriptedClient(
      (_i, w) => w.ctrl?.enqueue(mcpStateFrame()),
      (_i, w, chunk) => {
        for (const frame of parseConnectFrames(chunk)) {
          const exec = getFirstMsg(frame.payload, 2)
          if (!exec || !getFirstMsg(exec, 36) || reply || !w.ctrl) continue
          reply = exec
          w.ctrl.enqueue(textFrame("NO-TOOLS"))
          w.ctrl.enqueue(turnEndedFrame())
          w.ctrl.close()
          w.ctrl = undefined
        }
      },
    )
    const events = await collect(
      runCursorBidi(toollessReq, model as never, {
        url: "https://example.test/agent.v1.AgentService/Run",
        headers: {},
        initialRunBody: new Uint8Array([0]),
        sessionId: "toolless-mcp-state",
        modelId: "cursor-auto",
        networkClient: client,
      }),
      "mcp_state",
    )
    expect(reply).toBeDefined()
    const success = getFirstMsg(getFirstMsg(reply!, 36)!, 1)
    expect(success).toBeDefined()
    expect(getRepeatedMsg(success!, 1)).toHaveLength(0)
    expect(textOf(events)).toBe("NO-TOOLS")
  })
})
