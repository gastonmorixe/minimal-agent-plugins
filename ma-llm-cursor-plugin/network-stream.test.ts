/**
 * Net-seam characterization for Cursor AgentService/Run.
 *
 * What is under test: the adapter product path must speak Connect over the host
 * `NetworkClient` (protocol pin `h2`), not a private `node:http2` / curl stream.
 * That pin is load-bearing — Bun fetch is malformed on this bidi stream, and
 * dropping `protocol: "h2"` silently routes to the wrong transport.
 *
 * Why mock-only: a real Cursor call needs auth exchange + live AgentService and
 * would make this suite network-dependent. Custom bearer auth resolves offline;
 * the recorded request proves framing/headers/capture; the offline fixture proves
 * `translateCursorStream` still maps Connect frames → CanonicalEvents.
 *
 * Why these assertions must not be "simplified" away:
 * - `protocol: "h2"` + `allowFetchFallback: false` → force Http2Transport
 * - `application/connect+proto` on content-type/accept → Connect streaming wire
 * - framed body (flags 0 + length greater than 5) → AgentClientMessage is Connect-enveloped
 * - `capture.requestBody: base64:…` → binary-safe net-dbg (UTF-8 would corrupt)
 * - `capture.responseBody: false` → status/headers still logged; avoid duplicating
 *   long streamed model output on disk
 * - signal identity → cancel must reach the host client, not only local generators
 *
 * Ownership: tests only. Product path is `adapter.ts` + `connect/stream.ts`.
 */

import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { cursorAdapter } from "./adapter.ts"
import { cursorCaps } from "./capabilities.ts"
import { agentRunUrl } from "./connect/hosts.ts"
import { connectStreamPost } from "./connect/stream.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import type { NetworkClient, NetworkRequestInput, NetworkResponse } from "./lib/net-types.ts"
import type { ProviderAuth, RunContext } from "./lib/provider-auth.ts"
import { CURSOR_STREAM_CONTENT_TYPE, CURSOR_SURFACE_AGENT_RUN } from "./wire-constants.ts"

const ZERO_PRICING = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
} as const

const model = {
  id: "cursor-composer-2.5-fast",
  providerId: "cursor",
  surfaceId: CURSOR_SURFACE_AGENT_RUN,
  displayName: "Composer 2.5 Fast (Cursor)",
  capabilities: cursorCaps({ thinking: true }),
  pricing: ZERO_PRICING,
  tags: ["cursor", "live", "thinking"],
  vendorIds: { cursor: "composer-2.5-fast", firstParty: "composer-2.5-fast" },
}

/**
 * Custom bearer only — oauth/api-key paths hit real exchange/fetch and must not
 * appear in this offline seam suite (covered elsewhere).
 */
const customAuth: ProviderAuth = {
  kind: "custom",
  headers: { authorization: "Bearer test-access-token-redacted" },
}

async function loadFixtureBytes(): Promise<Uint8Array> {
  // Spike capture of a real AgentService/Run response (frames, not invented SSE).
  const path = join(import.meta.dir, "__fixtures__/run-resp.bin")
  return new Uint8Array(await Bun.file(path).arrayBuffer())
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** Structural NetworkClient: records the request the adapter built, returns fixture bytes. */
function makeFakeClient(
  opts: {
    body?: ReadableStream<Uint8Array>
    onRequest?: (input: NetworkRequestInput) => void
  } = {},
): { client: NetworkClient; calls: NetworkRequestInput[] } {
  const calls: NetworkRequestInput[] = []
  const client: NetworkClient = {
    request(input: NetworkRequestInput): Promise<NetworkResponse> {
      calls.push(input)
      opts.onRequest?.(input)
      if (!opts.body) {
        throw new Error("makeFakeClient: body stream required (pass fixture via opts.body)")
      }
      const res: NetworkResponse = {
        status: 200,
        headers: new Headers({
          "content-type": CURSOR_STREAM_CONTENT_TYPE,
        }),
        body: opts.body,
        // transport.protocol mirrors what Http2Transport reports on a real pin.
        transport: { id: "fake-h2", protocol: "h2", origin: new URL(input.url).origin },
        ok: true,
        text: async () => "",
        json: async <T = unknown>() => undefined as unknown as T,
      }
      return Promise.resolve(res)
    },
  }
  return { client, calls }
}

async function drain(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v
  }
  return undefined
}

describe("cursorAdapter.run — NetworkClient h2 connect+proto seam", () => {
  test("uses ctx.networkClient: protocol h2, POST, connect+proto, framed body, capture, signal", async () => {
    // Env override would force legacy http2/curl and bypass the NetworkClient seam.
    const prevTransport = process.env.MA_CURSOR_STREAM_TRANSPORT
    delete process.env.MA_CURSOR_STREAM_TRANSPORT
    try {
      const ac = new AbortController()
      const fixture = await loadFixtureBytes()
      expect(fixture.byteLength).toBeGreaterThan(0)
      const { client, calls } = makeFakeClient({ body: bytesToStream(fixture) })

      const req = {
        modelId: model.id,
        messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "ping" }] }],
        signal: ac.signal,
      }

      const ctx: RunContext = {
        auth: customAuth,
        sessionId: "test-session-network-stream",
        networkClient: client,
      }

      const events = await drain(cursorAdapter.run(req, model as never, ctx))

      // Injected client is the sole transport (proves no private http2/curl path).
      expect(calls).toHaveLength(1)
      const call = calls[0]!

      expect(call.method).toBe("POST")
      expect(call.url).toBe(agentRunUrl())
      // Without this pin the host may negotiate fetch/h1 and break Connect streaming.
      expect(call.protocol).toBe("h2")

      // Connect streaming content-type on both sides of negotiation.
      const contentType = headerOf(call.headers, "content-type")
      const accept = headerOf(call.headers, "accept")
      expect(contentType).toBe(CURSOR_STREAM_CONTENT_TYPE)
      expect(accept).toBe(CURSOR_STREAM_CONTENT_TYPE)

      // Custom bearer made it onto the wire (no exchange side path).
      const authorization = headerOf(call.headers, "authorization")
      expect(authorization).toBe("Bearer test-access-token-redacted")

      // Connect envelope: [flags u8][len u32 BE][proto…]; flags 0 = uncompressed data.
      expect(call.body).toBeInstanceOf(Uint8Array)
      const body = call.body as Uint8Array
      expect(body.byteLength).toBeGreaterThan(5)
      expect(body[0]).toBe(0)

      // Host diagnostics / policy tags used by net-dbg and transport selection.
      expect(call.label).toBe("cursor-agent-run")
      // Fetch fallback would reintroduce the Bun-malformed stream path.
      expect(call.allowFetchFallback).toBe(false)

      // Binary capture must be base64-prefixed; UTF-8 capture corrupts protobuf.
      // responseBody false: stream is consumed by the translator; host still sees chunks
      // via the response body stream without a second full-body snapshot requirement.
      expect(call.capture).toEqual({
        requestBody: `base64:${Buffer.from(body).toString("base64")}`,
        responseBody: false,
      })

      // Same AbortSignal instance — identity matters for host abort wiring.
      expect(call.signal).toBe(ac.signal)

      // Fixture frames still translate: seam must not break CanonicalEvent mapping.
      expect(events.some((e) => e.type === "message_start")).toBe(true)
      expect(events.some((e) => e.type === "text_delta" || e.type === "thinking_delta")).toBe(true)
      expect(events.some((e) => e.type === "message_stop")).toBe(true)
    } finally {
      if (prevTransport === undefined) delete process.env.MA_CURSOR_STREAM_TRANSPORT
      else process.env.MA_CURSOR_STREAM_TRANSPORT = prevTransport
    }
  })

  test("rejects an already-aborted request before calling NetworkClient", async () => {
    // Pre-abort must short-circuit before dialing — otherwise cancel races open a stream.
    const reason = new Error("already canceled")
    const signal = AbortSignal.abort(reason)
    const calls: NetworkRequestInput[] = []
    const client: NetworkClient = {
      request(input) {
        calls.push(input)
        throw new Error("network client must not be called")
      },
    }
    const stream = connectStreamPost({
      url: agentRunUrl(),
      headers: { "content-type": CURSOR_STREAM_CONTENT_TYPE },
      body: new Uint8Array([0, 0, 0, 0, 0]),
      signal,
      networkClient: client,
    })

    await expect(stream.next()).rejects.toBe(reason)
    expect(calls).toHaveLength(0)
  })
})
