/**
 * Ollama: an image in a tool_result reaches the wire. A role "tool" message
 * has a text `content` only, so the encoder puts a marker in the tool text
 * and sends the image in `images[]` of a user message after the tool
 * messages.
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalMessage } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { TOOL_RESULT_MEDIA_TEXT } from "@minimal-agent/core/plugin-api/llm/tool-result-media"

import { ollamaCaps } from "./capabilities.ts"
import type { ModelView } from "./lib/host-types.ts"
import { buildOllamaChatBody } from "./request-body.ts"

const MODEL: ModelView = {
  id: "m",
  providerId: "ollama",
  surfaceId: "custom",
  displayName: "m",
  capabilities: ollamaCaps({ contextWindow: 128_000, vision: true }),
  pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0, webSearchPerCallUSD: 0 },
}

/** The start of the 16x16 PNG of the cdp-screenshot golden. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ"

const IMAGE = {
  type: "image",
  source: { kind: "base64", mediaType: "image/png", data: PNG },
} as const

describe("ollama tool_result image", () => {
  it("sends the marker in the tool text and the image after all the tool messages", () => {
    const messages: CanonicalMessage[] = [
      { role: "user", content: [{ type: "text", text: "take a screenshot" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "c1", name: "Shot", input: {} },
          { type: "tool_use", id: "c2", name: "Read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "c1",
            content: [{ type: "text", text: "screenshot 16x16" }, IMAGE],
          },
          { type: "tool_result", toolUseId: "c2", content: [{ type: "text", text: "file A" }] },
        ],
      },
    ]
    const body = buildOllamaChatBody({ modelId: "m", messages }, MODEL)
    const tail = body.messages.slice(2)
    expect(tail).toEqual([
      {
        role: "tool",
        content: `screenshot 16x16\n${TOOL_RESULT_MEDIA_TEXT.marker(1)}`,
        tool_name: "c1",
      },
      { role: "tool", content: "file A", tool_name: "c2" },
      { role: "user", content: TOOL_RESULT_MEDIA_TEXT.label("c1"), images: [PNG] },
    ])
  })

  it("moves an image out of a role tool message", () => {
    const messages: CanonicalMessage[] = [
      { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "shot" }, IMAGE] },
    ]
    const body = buildOllamaChatBody({ modelId: "m", messages }, MODEL)
    expect(body.messages).toEqual([
      { role: "tool", content: `shot\n\n${TOOL_RESULT_MEDIA_TEXT.marker(1)}`, tool_name: "c1" },
      { role: "user", content: TOOL_RESULT_MEDIA_TEXT.label("c1"), images: [PNG] },
    ])
  })
})
