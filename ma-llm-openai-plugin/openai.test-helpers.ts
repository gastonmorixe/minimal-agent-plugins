/**
 * Shared helpers for OpenAI provider unit tests.
 *
 * Local test-registry bootstrap + SSE fixture replay utilities used by
 * `openai.test.ts` and `openai.stream-fixtures.test.ts`.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { expect } from "bun:test"

import { bootstrapOpenAI, openaiAdapter } from "./adapter.ts"
import { type OpenAIChatChunk, translateOpenAIChatStream } from "./chat/response-stream.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import { isEvent } from "./lib/canonical-events.ts"
import { userText } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import { type ModelEntry } from "./lib/host-types.ts"
import type { NetworkClient, NetworkRequestInput, NetworkResponse } from "./lib/net-types.ts"
import type { ProviderAuth } from "./lib/provider-auth.ts"
import { parseSse } from "./lib/sse-parser.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import {
  type OpenAIResponsesEvent,
  translateOpenAIResponsesStream,
} from "./responses/response-stream.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A repo-separated provider can't read back the HOST registry in its tests, so
// we drive registration through a local test registrar and resolve from it.
// This keeps the same registration path the host uses (bootstrapOpenAI →
// ctx.models/ctx.providers) while staying self-contained. Registered once,
// lazily, so the many resolveModel/resolveProvider call sites below are
// unchanged from the pre-migration test.
const testRegistry = makeTestRegistry()
let registered = false
/** Ensure the local OpenAI catalog + adapter are registered once. */
export function ensureRegistered(): void {
  if (registered) return
  bootstrapOpenAI({ models: testRegistry.models, providers: testRegistry.providers })
  registered = true
}

/** Resolve a model from the local test registry. */
export function resolveModel(id: string): ModelEntry {
  ensureRegistered()
  return testRegistry.resolveModel(id)
}

/** Resolve a provider adapter from the local test registry. */
export function resolveProvider(
  id: string,
): { validate: ProviderAdapterLike["validate"] } & ProviderAdapterLike {
  ensureRegistered()
  return testRegistry.resolveProvider(id) as never
}

/** Resolve a model or return undefined when missing. */
export function findModel(id: string): ModelEntry | undefined {
  ensureRegistered()
  try {
    return testRegistry.resolveModel(id)
  } catch {
    return undefined
  }
}
type ProviderAdapterLike = ReturnType<typeof testRegistry.resolveProvider>

// Host registry-reset shims. The moved plugin has no shared global registry to
// clear (each test resolves from the local `testRegistry`), so these are
// no-ops kept only so the many call sites below read unchanged.
/** Host registry-reset shim (no-op for the local test registry). */
export function clearModelRegistry(): void {}
/** Host registry-reset shim (no-op for the local test registry). */
export function clearProviderRegistry(): void {}

/** Read a named SSE fixture from `__fixtures__/`. */
export function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "__fixtures__", name), "utf-8")
}

/** Wrap a raw SSE string as a one-chunk ReadableStream for `parseSse`. */
export function sseStream(raw: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(raw)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** Collect an async event stream into an array. */
export async function collect(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

/** Replay a Chat Completions SSE fixture through the translator. */
export function replayChat(name: string): Promise<CanonicalEvent[]> {
  return collect(translateOpenAIChatStream(parseSse<OpenAIChatChunk>(sseStream(fixture(name)))))
}

/** Replay a Responses SSE fixture through the translator. */
export function replayResponses(name: string): Promise<CanonicalEvent[]> {
  return collect(
    translateOpenAIResponsesStream(parseSse<OpenAIResponsesEvent>(sseStream(fixture(name)))),
  )
}

/** First event of a given discriminant, narrowed to its concrete type. */
export function firstOf<T extends CanonicalEvent["type"]>(
  events: CanonicalEvent[],
  type: T,
): Extract<CanonicalEvent, { type: T }> | undefined {
  return events.find((e): e is Extract<CanonicalEvent, { type: T }> => e.type === type)
}

/** Concatenate all text_delta payloads. */
export function joinedText(events: CanonicalEvent[]): string {
  let out = ""
  for (const e of events) if (isEvent(e, "text_delta")) out += e.text
  return out
}

/** Last message_delta in the stream, if any. */
export function finalDelta(events: CanonicalEvent[]) {
  return firstOf([...events].reverse(), "message_delta")
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (controller) => controller.close() })
}

function failedResponse(status: number, body: string): NetworkResponse {
  return {
    ok: false,
    status,
    headers: new Headers(),
    body: emptyStream(),
    transport: { id: "test" },
    text: async () => body,
    json: async () => JSON.parse(body),
  }
}

/** Network client that records requests and always fails with a canned status. */
export function captureFailingNetwork(
  status = 418,
  body = '{"error":{"type":"test_error","message":"captured"}}',
): { requests: NetworkRequestInput[]; networkClient: NetworkClient } {
  const requests: NetworkRequestInput[] = []
  return {
    requests,
    networkClient: {
      async request(input) {
        requests.push(input)
        return failedResponse(status, body)
      },
    },
  }
}

/** Run a Responses request through a failing network client and return the captured input. */
export async function captureOpenAIResponseRequest(
  auth: ProviderAuth,
  reqPatch: Partial<CanonicalRequest> = {},
): Promise<NetworkRequestInput> {
  clearModelRegistry()
  clearProviderRegistry()
  bootstrapOpenAI()
  const { requests, networkClient } = captureFailingNetwork()
  const req: CanonicalRequest = {
    modelId: "gpt-5.5",
    messages: [userText("hi")],
    ...reqPatch,
  }

  await expect(
    collect(
      openaiAdapter.run(req, resolveModel("gpt-5.5"), {
        auth,
        sessionId: "test-session",
        networkClient,
      }),
    ),
  ).rejects.toThrow("OpenAI Responses API 418")

  expect(requests).toHaveLength(1)
  return requests[0]!
}
