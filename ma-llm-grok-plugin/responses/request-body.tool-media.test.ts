/**
 * Responses API: an image in a tool_result reaches the wire. This encoder
 * sends `function_call_output.output` as text, so it puts a marker in the
 * output and sends the image as `input_image` in a user message item after
 * all the function_call_output items.
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalMessage } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import { TOOL_RESULT_MEDIA_TEXT } from "@minimal-agent/core/plugin-api/llm/tool-result-media"

import type { ModelEntry } from "../lib/host-types.ts"

import { buildOpenAIResponsesBody } from "./request-body.ts"

const MODEL = {
  id: "m",
  providerId: "grok",
  surfaceId: "openai-responses",
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

describe("responses tool_result image", () => {
  it("sends the marker in the output and the image after all the outputs", () => {
    const body = buildOpenAIResponsesBody({ modelId: "m", messages: MESSAGES }, MODEL)
    const tail = (body.input as unknown[]).slice(-3)
    expect(tail[0]).toEqual({
      type: "function_call_output",
      call_id: "c1",
      output: `screenshot 16x16\n${TOOL_RESULT_MEDIA_TEXT.marker(1)}`,
    })
    expect(tail[1]).toEqual({ type: "function_call_output", call_id: "c2", output: "file A" })
    expect(tail[2]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: TOOL_RESULT_MEDIA_TEXT.label("c1") },
        { type: "input_image", image_url: `data:image/png;base64,${PNG}` },
        { type: "input_text", text: "host note" },
      ],
    })
  })
})
