/**
 * Antigravity: an image in a tool_result reaches the wire. The
 * `functionResponse.response.output` is text only, so the encoder puts a
 * marker in the output and sends the image as `inlineData` after every
 * functionResponse part of the same user content.
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalMessage } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { TOOL_RESULT_MEDIA_TEXT } from "@minimal-agent/core/plugin-api/llm/tool-result-media"

import { CAPS_GEMINI_4 } from "./capabilities.ts"
import { PRICING_ANTIGRAVITY_PLAN } from "./pricing.ts"
import { buildAntigravityBody, THOUGHT_SIGNATURE_SENTINEL } from "./request-body.ts"

/** The start of the 16x16 PNG of the cdp-screenshot golden. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ"

type Part = Record<string, unknown>
type Contents = Array<{ role: string; parts: Part[] }>

function contents(messages: CanonicalMessage[]): Contents {
  const modelId = "gemini-4-neon-high"
  const built = buildAntigravityBody(
    { modelId, messages },
    {
      id: modelId,
      providerId: "antigravity",
      surfaceId: "custom",
      displayName: modelId,
      capabilities: CAPS_GEMINI_4,
      pricing: PRICING_ANTIGRAVITY_PLAN,
    },
    { project: "p", modelId, requestId: "r" },
  ).body as { request: { contents: Contents } }
  return built.request.contents
}

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

describe("antigravity tool_result image", () => {
  it("sends the marker in the output and the image after every functionResponse", () => {
    const all = contents(MESSAGES)
    const parts = all.at(-1)?.parts ?? []
    expect(parts).toEqual([
      {
        functionResponse: {
          id: "c1",
          name: "Shot",
          response: { output: `screenshot 16x16\n\n${TOOL_RESULT_MEDIA_TEXT.marker(1)}` },
        },
      },
      { functionResponse: { id: "c2", name: "Read", response: { output: "file A" } } },
      { text: TOOL_RESULT_MEDIA_TEXT.label("c1") },
      { inlineData: { mimeType: "image/png", data: PNG } },
      { text: "host note" },
    ])
    // The tail still ends at a tool result, so the unsigned step keeps the
    // sentinel. Gemini checks the FIRST call of a parallel step, so the
    // sentinel goes there (live e2e "continues a turn whose signatures were
    // lost" has a parallel step).
    const step = all.at(-2)?.parts ?? []
    expect(step[0]?.thoughtSignature).toBe(THOUGHT_SIGNATURE_SENTINEL)
    expect(step[1]).not.toHaveProperty("thoughtSignature")
  })
})
