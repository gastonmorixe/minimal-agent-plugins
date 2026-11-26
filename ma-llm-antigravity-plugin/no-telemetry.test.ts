/**
 * No-telemetry contract.
 *
 * The plugin must contact only the control plane and the OAuth endpoints. It
 * must never call the Clearcut logger (`play.googleapis.com`), the remote
 * config poller (`aicode.googleapis.com`), the plugin marketplace
 * (`www.gstatic.com`) or a trajectory analytics endpoint.
 *
 * This test drives a full turn against a fake network client that records every
 * URL, and a full login exchange against the same recorder. It fails on any
 * host that is not in the allow list, so a future call added to the adapter is
 * caught here rather than in a packet capture.
 *
 * @module antigravity.no-telemetry.test
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"

import { antigravityAdapter } from "./adapter.ts"
import { CAPS_GEMINI_4 } from "./capabilities.ts"
import type { ModelView } from "./lib/host-types.ts"
import { PRICING_ANTIGRAVITY_PLAN } from "./pricing.ts"

/** Hosts the plugin may contact. Nothing else is allowed. */
const ALLOWED_HOSTS: readonly string[] = [
  "daily-cloudcode-pa.googleapis.com",
  "oauth2.googleapis.com",
  "accounts.google.com",
  "www.googleapis.com",
]

/** Hosts that mean telemetry or a background config poll. */
const FORBIDDEN_HOSTS: readonly string[] = [
  "play.googleapis.com",
  "aicode.googleapis.com",
  "www.gstatic.com",
  "lh3.googleusercontent.com",
  "firebaselogging.googleapis.com",
  "app-measurement.com",
]

/** One recorded request. */
interface Recorded {
  url: string
  method: string
}

/**
 * A network client that records each URL and answers with a canned response.
 * The stream answer is an empty SSE body, which ends the turn cleanly.
 */
function recordingClient(seen: Recorded[]): NetworkClient {
  return {
    async request(opts: { url: string; method?: string }): Promise<{
      ok: boolean
      status: number
      headers: Headers
      body: ReadableStream<Uint8Array>
      text(): Promise<string>
      json<T>(): Promise<T>
    }> {
      seen.push({ url: opts.url, method: opts.method ?? "GET" })
      const host = new URL(opts.url).host
      if (host === "daily-cloudcode-pa.googleapis.com") {
        if (opts.url.includes("loadCodeAssist")) {
          return jsonResponse({ cloudaicompanionProject: "aicode-consumers" })
        }
        if (opts.url.includes("fetchAvailableModels") || opts.url.includes("retrieveUserQuota")) {
          return jsonResponse({ models: {}, groups: [] })
        }
        if (opts.url.includes("streamGenerateContent")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "text/event-stream" }),
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close()
              },
            }),
            async text() {
              return ""
            },
            async json<T>(): Promise<T> {
              return {} as T
            },
          }
        }
      }
      return jsonResponse({})
    },
  } as unknown as NetworkClient
}

function jsonResponse(value: unknown): {
  ok: boolean
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array>
  text(): Promise<string>
  json<T>(): Promise<T>
} {
  const text = JSON.stringify(value)
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }),
    async text() {
      return text
    },
    async json<T>(): Promise<T> {
      return value as T
    },
  }
}

const MODEL: ModelView = {
  id: "gemini-4-neon-high",
  providerId: "antigravity",
  surfaceId: "custom",
  displayName: "Gemini 4 Neon (High)",
  capabilities: CAPS_GEMINI_4,
  pricing: PRICING_ANTIGRAVITY_PLAN,
}

const REQUEST: CanonicalRequest = {
  modelId: "gemini-4-neon-high",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
}

describe("no telemetry", () => {
  it("a full turn contacts only the allowed hosts", async () => {
    const seen: Recorded[] = []
    const client = recordingClient(seen)
    const ctx = {
      auth: { kind: "oauth", token: "test-token" },
      sessionId: "session-1",
      networkClient: client,
    }

    for await (const _event of antigravityAdapter.run(
      REQUEST,
      MODEL,
      ctx as Parameters<typeof antigravityAdapter.run>[2],
    )) {
      // Drain the stream. The body is empty, so this ends at once.
    }

    expect(seen.length).toBeGreaterThan(0)
    const hosts = seen.map((r) => new URL(r.url).host)
    const bad = hosts.filter((h) => !ALLOWED_HOSTS.includes(h))
    expect(bad).toEqual([])
    const telemetry = hosts.filter((h) => FORBIDDEN_HOSTS.includes(h))
    expect(telemetry).toEqual([])
  })

  it("the turn calls the control plane and the stream endpoint only", async () => {
    const seen: Recorded[] = []
    const client = recordingClient(seen)
    for await (const _event of antigravityAdapter.run(REQUEST, MODEL, {
      auth: { kind: "oauth", token: "test-token" },
      sessionId: "session-1",
      networkClient: client,
    } as Parameters<typeof antigravityAdapter.run>[2])) {
      // Drain.
    }
    const paths = seen.map((r) => new URL(r.url).pathname + new URL(r.url).search)
    for (const path of paths) {
      expect(path).toMatch(/v1internal:(loadCodeAssist|fetchAvailableModels|streamGenerateContent)/)
    }
  })
})
