/**
 * Golden Responses API usage payload to CanonicalUsage. Canonical
 * `inputTokens` excludes cached tokens. Responses `input_tokens` includes
 * `input_tokens_details.cached_tokens`, so the adapter subtracts them.
 */

import { describe, expect, it } from "bun:test"

import type {
  CanonicalEvent,
  CanonicalUsage,
} from "@minimal-agent/core/plugin-api/llm/canonical-events"

import { type OpenAIResponsesEvent, translateOpenAIResponsesStream } from "./response-stream.ts"

async function* fromArray(events: OpenAIResponsesEvent[]): AsyncIterable<OpenAIResponsesEvent> {
  for (const ev of events) yield ev
}

async function finalUsage(usage: Record<string, unknown>): Promise<CanonicalUsage | undefined> {
  const golden = [
    { type: "response.created", response: { id: "resp_1", model: "test-model" } },
    { type: "response.completed", response: { id: "resp_1", status: "completed", usage } },
  ] as unknown as OpenAIResponsesEvent[]
  let out: CanonicalUsage | undefined
  for await (const ev of translateOpenAIResponsesStream(
    fromArray(golden),
  ) as AsyncIterable<CanonicalEvent>) {
    if (ev.type === "message_delta") out = ev.usage
  }
  return out
}

describe("Responses usage mapping", () => {
  it("input 1500 with 200 cached maps to input 1300 + cache read 200 (used 1500)", async () => {
    const usage = await finalUsage({
      input_tokens: 1500,
      input_tokens_details: { cached_tokens: 200 },
      output_tokens: 40,
      output_tokens_details: { reasoning_tokens: 10 },
      total_tokens: 1540,
    })
    expect(usage?.inputTokens).toBe(1300)
    expect(usage?.cacheReadTokens).toBe(200)
    expect(usage?.outputTokens).toBe(40)
    expect(usage?.reasoningTokens).toBe(10)
    const used =
      (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheCreationTokens ?? 0)
    expect(used).toBe(1500)
  })

  it("keeps all input tokens as input when the provider reports no cached tokens", async () => {
    const usage = await finalUsage({ input_tokens: 1500, output_tokens: 40 })
    expect(usage?.inputTokens).toBe(1500)
    expect(usage?.cacheReadTokens).toBeUndefined()
  })
})
