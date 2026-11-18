/**
 * Chat Completions role "tool" message: a non-text block becomes JSON text.
 * The internal block keys `sideband` and `outcome` must not go on the wire
 * (SPEC v6.1 D8 rule 8, D9). A block without them keeps its bytes.
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"

import type { ModelEntry } from "../lib/host-types.ts"

import { buildOpenAIChatBody } from "./request-body.ts"

const MODEL = {
  id: "m",
  providerId: "openai",
  surfaceId: "openai-chat-completions",
  displayName: "m",
  capabilities: defaultCapabilities(),
  pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0 },
} as ModelEntry

// A non-text, non-tool_result block: a tool_result in any message takes the
// separate tool_result path (request-body.ts buildChatMessages), so only
// these blocks reach the JSON text of a role "tool" message.
const PLAIN: CanonicalBlock = {
  type: "image",
  source: { kind: "url", url: "https://example.test/a.png" },
}

/** The string content of the role "tool" message. */
function toolText(block: CanonicalBlock): string {
  const body = buildOpenAIChatBody(
    {
      modelId: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "tool", toolCallId: "t1", content: [{ type: "text", text: "note" }, block] },
      ],
    },
    MODEL,
  )
  const msg = body.messages[1] as { role: string; content: string }
  expect(msg.role).toBe("tool")
  return msg.content
}

describe("openai chat role tool message: no metadata on the wire", () => {
  it("drops `sideband` from the block", () => {
    const text = toolText({ ...PLAIN, sideband: { kind: "notice" } } as CanonicalBlock)
    expect(text).not.toContain("sideband")
    expect(text).toBe(toolText(PLAIN))
  })

  it("drops `outcome` from the block", () => {
    const text = toolText({
      ...PLAIN,
      outcome: { v: 1, bodyEnd: 2, annotations: [] },
    } as CanonicalBlock)
    expect(text).not.toContain("outcome")
    expect(text).not.toContain("bodyEnd")
    expect(text).toBe(toolText(PLAIN))
  })

  it("keeps the bytes of a block with no metadata", () => {
    expect(toolText(PLAIN)).toBe(`note\n${JSON.stringify(PLAIN)}`)
  })
})
