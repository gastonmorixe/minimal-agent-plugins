/**
 * Chat Completions: an image in a tool_result reaches the wire. A role "tool"
 * message takes only text, so the encoder puts a marker in the tool text and
 * sends the image in a user message after all the tool messages.
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalMessage } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import { TOOL_RESULT_MEDIA_TEXT } from "@minimal-agent/core/plugin-api/llm/tool-result-media"

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

/** The start of the 16x16 PNG of the cdp-screenshot golden. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ"

const MESSAGES: CanonicalMessage[] = [
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
        content: [
          { type: "text", text: "screenshot 16x16" },
          { type: "image", source: { kind: "base64", mediaType: "image/png", data: PNG } },
        ],
      },
      { type: "tool_result", toolUseId: "c2", content: [{ type: "text", text: "file A" }] },
      { type: "text", text: "host note" },
    ],
  },
]

describe("openai chat tool_result image", () => {
  it("sends the marker in the tool text and the image after all the tool messages", () => {
    const body = buildOpenAIChatBody({ modelId: "m", messages: MESSAGES }, MODEL)
    const tail = body.messages.slice(2)
    expect(tail.map((m) => m.role)).toEqual(["tool", "tool", "user"])
    expect(tail[0]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: `screenshot 16x16\n${TOOL_RESULT_MEDIA_TEXT.marker(1)}`,
    })
    expect(tail[1]).toEqual({ role: "tool", tool_call_id: "c2", content: "file A" })
    expect(tail[2]?.content).toEqual([
      { type: "text", text: TOOL_RESULT_MEDIA_TEXT.label("c1") },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
      { type: "text", text: "host note" },
    ])
  })
})
