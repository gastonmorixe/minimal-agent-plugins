/**
 * Regression pin: the canonical Anthropic adapter's `run()` MUST broadcast
 * the response's rate-limit headers into the in-process quota cache, exactly
 * as the legacy `client.ts` chat path and the dedicated quota probe both do.
 *
 * Why this exists: the Wave-B transport flip made `canonicalSendFn` the
 * default for every registered model. The canonical chat path re-emits
 * `quota.headersReceived` from the *cached* snapshot
 * (`rebroadcastQuotaForSessionUpdate`) but never wrote the FRESH headers each
 * real chat response carries on the wire. The status-bar slot gates the cache
 * on a 60s freshness window, so once the cold-start prime probe's snapshot
 * aged out, `parseAnthropicQuotaWindows` saw an empty map and the 5h/7d
 * windows collapsed off the footer after "a few seconds of working".
 *
 * The fix lives in the PROVIDER plugin (provider-neutral core stays agnostic):
 * the adapter broadcasts its own response headers via the neutral
 * `broadcastResponseRateLimits` helper. This test pins that contract at the
 * adapter seam so the windows keep refreshing on every real turn.
 *
 * @module llm/providers/anthropic/adapter.broadcast.test
 */

import { beforeEach, describe, expect, it } from "bun:test"

import { anthropicAdapter, bootstrapAnthropic } from "./adapter.ts"
import { userText } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import type { NetworkClient, NetworkRequest, NetworkResponse } from "./lib/net-types.ts"
import type { ProviderAuth, RunContext } from "./lib/provider-auth.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { clearAnthropicRateLimits, getAnthropicRateLimits } from "./session-info.ts"

/** Minimal well-formed Anthropic SSE body: message_start → message_stop. */
function sseBody(): ReadableStream<Uint8Array> {
  const text =
    "event: message_start\n" +
    'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
    "event: message_stop\n" +
    'data: {"type":"message_stop"}\n\n'
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** A network client that returns a 200 carrying the given headers + an SSE body. */
function fakeChatClient(headers: Headers): NetworkClient {
  return {
    request: async (_req: NetworkRequest): Promise<NetworkResponse> =>
      ({
        ok: true,
        status: 200,
        headers,
        body: sseBody(),
        text: async () => "",
        json: async <T>() => ({}) as T,
      }) as unknown as NetworkResponse,
  } as NetworkClient
}

let resolveModel: (id: string) => ModelEntry
describe("anthropicAdapter.run rate-limit broadcast", () => {
  beforeEach(() => {
    clearAnthropicRateLimits()
    const reg = makeTestRegistry()
    bootstrapAnthropic(reg.ctx)
    resolveModel = reg.resolveModel
  })

  it("broadcasts the chat response's rate-limit headers into the quota cache", async () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.16",
      "anthropic-ratelimit-unified-5h-reset": "1781311200",
      "anthropic-ratelimit-unified-7d-utilization": "0.79",
      "anthropic-ratelimit-unified-7d-reset": "1781452800",
    })

    const req: CanonicalRequest = {
      modelId: "claude-opus-4-8",
      messages: [userText("hi")],
    }
    const model = resolveModel("claude-opus-4-8")
    const auth: ProviderAuth = { kind: "oauth", token: "tok-1" }
    const ctx: RunContext = {
      auth,
      sessionId: "s1",
      networkClient: fakeChatClient(headers),
    }

    // Drain the canonical event stream (the adapter only reads headers after
    // the request resolves; the broadcast must land by the time we finish).
    for await (const _ev of anthropicAdapter.run!(req, model, ctx)) {
      // no-op
    }

    const cached = getAnthropicRateLimits()
    expect(cached).not.toBeNull()
    expect(cached?.rateLimits.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.16")
    expect(cached?.rateLimits.get("anthropic-ratelimit-unified-7d-utilization")).toBe("0.79")
  })
})
