/**
 * Offline: the allowlist header fails hard when the server needs a tool we did
 * not allow ("Required tool X not found in allTools"). The adapter must learn
 * that tool, retry the Run once with it allowed, and only then surface the
 * error. The retry must happen only before any output reached the host.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { cursorAdapter } from "./adapter.ts"
import { cursorCaps } from "./capabilities.ts"
import { connectFrameProto } from "./connect/stream.ts"
import { resetCursorBidiSessionsForTests } from "./cursor-bidi-session.ts"
import {
  CURSOR_ALLOWED_TOOLS_HEADER,
  resetCursorLearnedToolsForTests,
} from "./cursor-tool-policy.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import type { NetworkClient, NetworkRequestInput, NetworkResponse } from "./lib/net-types.ts"
import type { ProviderAuth, RunContext } from "./lib/provider-auth.ts"
import { encMsg, encString } from "./proto/wire.ts"
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

const req = {
  modelId: "cursor-auto",
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  tools: [{ name: "ModelInfo", description: "meta", inputSchema: { type: "object" } }],
}

/** Connect end-stream frame (flag 0x02) carrying a JSON error. */
function endStreamError(message: string): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ error: { code: "internal", message } }))
  const out = new Uint8Array(5 + json.length)
  out[0] = 0x02
  new DataView(out.buffer).setUint32(1, json.length)
  out.set(json, 5)
  return out
}

function textThenEnd(text: string): Uint8Array[] {
  return [
    connectFrameProto(encMsg(1, encMsg(1, encString(1, text)))),
    connectFrameProto(encMsg(1, encMsg(14, new Uint8Array(0)))),
  ]
}

function fakeClient(bodies: Array<Uint8Array[]>): {
  client: NetworkClient
  calls: NetworkRequestInput[]
} {
  const calls: NetworkRequestInput[] = []
  const client: NetworkClient = {
    request(input: NetworkRequestInput): Promise<NetworkResponse> {
      calls.push(input)
      const frames = bodies[calls.length - 1] ?? [endStreamError("no more fake bodies")]
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const f of frames) c.enqueue(f)
          c.close()
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
        writeRequestBody() {},
        endRequestBody() {},
      } satisfies NetworkResponse)
    },
  }
  return { client, calls }
}

function allowedOf(input: NetworkRequestInput): string[] {
  const h = input.headers ?? {}
  const v = Object.entries(h).find(([k]) => k.toLowerCase() === CURSOR_ALLOWED_TOOLS_HEADER)?.[1]
  return v ? v.split(",").sort() : []
}

async function run(client: NetworkClient, sessionId: string): Promise<CanonicalEvent[]> {
  const ctx: RunContext = { auth, sessionId, networkClient: client }
  const out: CanonicalEvent[] = []
  for await (const ev of cursorAdapter.run(req, model as never, ctx)) out.push(ev)
  return out
}

const REQUIRED = "Required tool CREATE_PLAN not found in allTools"

describe("cursor tool allowlist self-heal", () => {
  afterEach(() => {
    delete process.env.MA_CURSOR_BIDI_HEARTBEAT_MS
    resetCursorLearnedToolsForTests()
    resetCursorBidiSessionsForTests()
  })

  test("retries once with the required tool allowed, then succeeds", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    const { client, calls } = fakeClient([[endStreamError(REQUIRED)], textThenEnd("OK")])
    const events = await run(client, "self-heal-ok")

    expect(calls).toHaveLength(2)
    expect(allowedOf(calls[0]!)).not.toContain("create_plan_tool_call")
    expect(allowedOf(calls[1]!)).toContain("create_plan_tool_call")
    expect(events.some((e) => e.type === "stream_error")).toBe(false)
    const text = events
      .filter((e): e is Extract<CanonicalEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("")
    expect(text).toBe("OK")
  })

  test("remembers the tool: the next Run allows it from the first request", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    const first = fakeClient([[endStreamError(REQUIRED)], textThenEnd("A")])
    await run(first.client, "self-heal-learn-1")
    const second = fakeClient([textThenEnd("B")])
    await run(second.client, "self-heal-learn-2")
    expect(second.calls).toHaveLength(1)
    expect(allowedOf(second.calls[0]!)).toContain("create_plan_tool_call")
  })

  test("retries only once: a second Required-tool error is surfaced", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    const { client, calls } = fakeClient([
      [endStreamError(REQUIRED)],
      [endStreamError("Required tool ASK_QUESTION not found in allTools")],
    ])
    const events = await run(client, "self-heal-once")
    expect(calls).toHaveLength(2)
    const err = events.find((e) => e.type === "stream_error")
    expect(String(err && "cause" in err ? err.cause : "")).toContain("ASK_QUESTION")
  })

  test("does not retry for an unknown tool enum", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    const { client, calls } = fakeClient([
      [endStreamError("Required tool NOPE_NOPE not found in allTools")],
    ])
    const events = await run(client, "self-heal-unknown")
    expect(calls).toHaveLength(1)
    expect(events.some((e) => e.type === "stream_error")).toBe(true)
  })

  test("does not retry after output already reached the host", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    const { client, calls } = fakeClient([
      [connectFrameProto(encMsg(1, encMsg(1, encString(1, "partial")))), endStreamError(REQUIRED)],
    ])
    const events = await run(client, "self-heal-late")
    expect(calls).toHaveLength(1)
    expect(events.some((e) => e.type === "stream_error")).toBe(true)
  })
})
