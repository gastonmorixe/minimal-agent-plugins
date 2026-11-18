/**
 * F3 (M1): the opencode-go copy of the Anthropic body builder keeps at most 4
 * cache markers on the wire, the same as the shared builder.
 */

import { describe, expect, it } from "bun:test"

import { countCacheMarkers } from "@minimal-agent/core/plugin-api/llm/anthropic-request"
import type {
  CanonicalBlock,
  CanonicalMessage,
} from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"

import { buildAnthropicRequestBody } from "./anthropic-request.ts"
import type { ModelView } from "./host-types.ts"

const MODEL = {
  id: "m",
  providerId: "opencode-go",
  surfaceId: "anthropic-messages",
  displayName: "m",
  capabilities: { ...defaultCapabilities(), maxOutputTokens: 1024 },
  pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0 },
} as ModelView

const eph = { kind: "ephemeral", ttl: "5m" } as const
const block = (t: string, cached: boolean): CanonicalBlock =>
  (cached ? { type: "text", text: t, cache: eph } : { type: "text", text: t }) as CanonicalBlock
const msg = (role: "user" | "assistant", t: string, cached: boolean): CanonicalMessage =>
  ({ role, content: [block(t, cached)] }) as CanonicalMessage

/** 3 system markers + anchor (message 2) + tail (message 4) = 5 before the cap. */
function build(systemMarks: number) {
  return buildAnthropicRequestBody(
    {
      modelId: "m",
      system: Array.from({ length: 3 }, (_, i) => block(`s${i}`, i < systemMarks)),
      messages: [
        msg("user", "go", false),
        msg("assistant", "a1", false),
        msg("user", "r1", true),
        msg("assistant", "a2", false),
        msg("user", "r2", true),
      ],
    },
    MODEL,
  )
}

const marker = (body: ReturnType<typeof build>, i: number): unknown =>
  (body.messages[i]!.content as Array<{ cache_control?: unknown }>)[0]!.cache_control

describe("opencode-go body builder: cache marker cap (F3)", () => {
  it("3 system markers + anchor + tail -> 4 on the wire (anchor dropped, tail kept)", () => {
    const body = build(3)
    expect(countCacheMarkers(body as never)).toBe(4)
    expect(body.system?.filter((b) => b.cache_control).length).toBe(3)
    expect(marker(body, 2)).toBeUndefined()
    expect(marker(body, 4)).toEqual({ type: "ephemeral", ttl: "5m" })
  })

  it("4 markers or fewer: the body is not changed", () => {
    const body = build(2)
    expect(countCacheMarkers(body as never)).toBe(4)
    expect(marker(body, 2)).toEqual({ type: "ephemeral", ttl: "5m" })
    expect(marker(body, 4)).toEqual({ type: "ephemeral", ttl: "5m" })
  })
})
