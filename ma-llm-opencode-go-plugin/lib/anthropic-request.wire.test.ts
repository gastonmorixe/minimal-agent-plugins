/**
 * Mid-conversation system message: a non-text block becomes JSON text. The
 * internal block keys `sideband` and `outcome` must not go on the wire
 * (SPEC v6.1 D8 rule 8, D9). A block without them keeps its bytes.
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
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

const PLAIN: CanonicalBlock = {
  type: "tool_result",
  toolUseId: "t1",
  content: [{ type: "text", text: "ok" }],
}

/** The string content of the mid-conversation system message. */
function systemText(block: CanonicalBlock): string {
  const body = buildAnthropicRequestBody(
    {
      modelId: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "system", content: [{ type: "text", text: "note" }, block] },
      ],
    },
    MODEL,
  )
  return body.messages[1]!.content as string
}

describe("opencode-go mid-conversation system block: no metadata on the wire", () => {
  it("drops `sideband` from a tool_result", () => {
    const text = systemText({ ...PLAIN, sideband: { kind: "notice" } } as CanonicalBlock)
    expect(text).not.toContain("sideband")
    expect(text).toBe(systemText(PLAIN))
  })

  it("drops `outcome` from a tool_result", () => {
    const text = systemText({
      ...PLAIN,
      outcome: { v: 1, bodyEnd: 2, annotations: [] },
    } as CanonicalBlock)
    expect(text).not.toContain("outcome")
    expect(text).not.toContain("bodyEnd")
    expect(text).toBe(systemText(PLAIN))
  })

  it("keeps the bytes of a block with no metadata", () => {
    expect(systemText(PLAIN)).toBe(`note\n${JSON.stringify(PLAIN)}`)
  })
})
