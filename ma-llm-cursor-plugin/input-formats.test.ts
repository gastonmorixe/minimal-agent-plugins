/**
 * Input formats: the Agent Run encoder sends text only, so no Cursor model
 * takes an attachment. An attachment is rejected up front (validate), and a
 * media block that still reaches the encoder becomes the core placeholder
 * text (not `[type]`, no silent drop).
 */

import { describe, expect, test } from "bun:test"

import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import { resolveInputMimeTypes } from "@minimal-agent/core/plugin-api/llm/capabilities"

import { cursorCaps } from "./capabilities.ts"
import type { ModelView } from "./lib/host-types.ts"
import { registerCursorModels } from "./models.ts"
import { decodeFields, fieldBytes, fieldString } from "./proto/wire.ts"
import { buildCursorAgentRunBody, summarizeRequestText } from "./request-body.ts"
import { validateCursorRequest } from "./validate.ts"
import { CURSOR_SURFACE_AGENT_RUN } from "./wire-constants.ts"

/** The core default accepted set (images, PDF, text/plain). */
const CORE_DEFAULT = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"]

const model: ModelView = {
  id: "cursor-auto",
  providerId: "cursor",
  surfaceId: CURSOR_SURFACE_AGENT_RUN,
  displayName: "Auto (Cursor)",
  capabilities: cursorCaps({ vision: true }),
  pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0, webSearchPerCallUSD: 0 },
  vendorIds: { cursor: "default" },
}

function req(...content: CanonicalBlock[]): CanonicalRequest {
  return { modelId: "cursor-auto", messages: [{ role: "user", content }] }
}

function userText(body: Uint8Array): string {
  const run = decodeFields(fieldBytes(decodeFields(body).find((f) => f.no === 1)!)!)
  const action = fieldBytes(run.find((f) => f.no === 2)!)!
  const uma = fieldBytes(decodeFields(action).find((f) => f.no === 1)!)!
  const um = fieldBytes(decodeFields(uma).find((f) => f.no === 1)!)!
  return fieldString(decodeFields(um).find((f) => f.no === 1)!) ?? ""
}

const IMAGE: CanonicalBlock = {
  type: "image",
  source: { kind: "base64", mediaType: "image/png", data: "I" },
}
const PDF: CanonicalBlock = {
  type: "file",
  source: { kind: "base64", mediaType: "application/pdf", data: "P" },
}
const AUDIO: CanonicalBlock = {
  type: "audio",
  source: { kind: "base64", format: "wav", mediaType: "audio/wav", data: "A" },
}
const VIDEO: CanonicalBlock = { type: "video", source: { kind: "url", url: "https://x/v.mp4" } }

describe("Cursor input formats", () => {
  test("no model takes image input, also with the vision flag", () => {
    expect(model.capabilities.modalities).toEqual({
      image: false,
      audio: false,
      pdf: false,
      video: false,
    })
    expect(model.capabilities.inputMimeTypes).toBeUndefined()
    expect(resolveInputMimeTypes(model.capabilities, CORE_DEFAULT)).toEqual([])
  })

  test("every catalog model resolves to no attachment; the vision tag stays", () => {
    const specs: Array<{ id: string; tags?: string[]; capabilities: ModelView["capabilities"] }> =
      []
    registerCursorModels({ register: (s: never) => void specs.push(s), setDefault() {} } as never)
    expect(specs.length).toBeGreaterThan(0)
    for (const s of specs) {
      expect(resolveInputMimeTypes(s.capabilities, CORE_DEFAULT)).toEqual([])
    }
    expect(specs.some((s) => s.tags?.includes("vision"))).toBe(true)
  })

  test("validate rejects image, PDF, audio and video up front", () => {
    const res = validateCursorRequest(req(IMAGE, PDF, AUDIO, VIDEO), model)
    expect(res.errors.filter((e) => String(e.capability) === "modalities")).toHaveLength(4)
  })
})

describe("Cursor encoder attachments", () => {
  test("each media block becomes the placeholder text", () => {
    const text = userText(
      buildCursorAgentRunBody(req({ type: "text", text: "look" }, IMAGE, PDF, AUDIO, VIDEO), model),
    )
    expect(text).toBe(
      [
        "user: look",
        "[image attachment not sent: cursor-auto does not accept image/png]",
        "[file attachment not sent: cursor-auto does not accept application/pdf]",
        "[audio attachment not sent: cursor-auto does not accept audio/wav]",
        "[video attachment not sent: cursor-auto does not accept video]",
      ].join("\n"),
    )
  })

  test("an image in a tool result becomes the placeholder, not [image]", () => {
    const text = summarizeRequestText(
      req({
        type: "tool_result",
        toolUseId: "t1",
        content: [
          { type: "text", text: "shot" },
          IMAGE as Extract<CanonicalBlock, { type: "image" }>,
        ],
      }),
    )
    expect(text).toContain("[image attachment not sent: cursor-auto does not accept image/png]")
    expect(text).not.toContain("[image]\n")
  })
})
