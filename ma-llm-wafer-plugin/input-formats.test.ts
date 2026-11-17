/**
 * Per-model input formats, media limits and the chat encoder output for each
 * attachment block (image_url, or the core placeholder text).
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"

import { bootstrapWafer, waferAdapter } from "./adapter.ts"
import { WAFER_IMAGE_MIME_TYPES } from "./input-formats.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"

const VISION = "Kimi-K3"
const TEXT = "GLM-5.3"

function registry() {
  const reg = makeTestRegistry()
  bootstrapWafer({ models: reg.models, providers: reg.providers })
  return reg
}

/** Run the adapter with a fake network client and capture the sent content. */
async function sentContent(model: ModelEntry, ...content: CanonicalBlock[]): Promise<unknown> {
  const req: CanonicalRequest = { modelId: model.id, messages: [{ role: "user", content }] }
  let sent = ""
  const networkClient = {
    request: async (r: { body: string }) => {
      sent = r.body
      throw new Error("stop")
    },
  }
  try {
    for await (const _ of waferAdapter.run(req, model, {
      auth: { kind: "api-key", key: "k" },
      networkClient,
    } as never)) {
      // no events: the fake client throws first
    }
  } catch {
    // expected
  }
  return (JSON.parse(sent) as { messages: Array<{ content: unknown }> }).messages[0]?.content
}

describe("Wafer per-model input formats", () => {
  const reg = registry()

  it("a vision model takes jpeg, png, gif and webp only (no PDF)", () => {
    for (const id of [VISION, "Kimi-K3.1-Pro", "GLM-5.3-Flash", "DeepSeek-V4.1-Flash"]) {
      expect(reg.resolveModel(id).capabilities.inputMimeTypes).toEqual(WAFER_IMAGE_MIME_TYPES)
    }
  })

  it("a text model takes no attachment", () => {
    for (const id of [TEXT, "GLM-5.2", "DeepSeek-V4-Pro"]) {
      expect(reg.resolveModel(id).capabilities.inputMimeTypes).toEqual([])
    }
  })

  it("mediaLimits gives the model list and the core default sizes", () => {
    const limits = waferAdapter.mediaLimits!(reg.resolveModel(VISION))
    expect([...limits.acceptedMimeTypes]).toEqual([...WAFER_IMAGE_MIME_TYPES])
    expect(limits.acceptedMimeTypes.has("application/pdf")).toBe(false)
    expect(limits.maxBytesPerItem).toBe(5 * 1024 * 1024)
    expect(limits.maxRequestBytes).toBe(32 * 1024 * 1024)
    expect(limits.maxItemsPerRequest).toBe(100)
    expect(limits.maxDimension).toBe(8000)
    expect(waferAdapter.mediaLimits!(reg.resolveModel(TEXT)).acceptedMimeTypes.size).toBe(0)
  })
})

describe("Wafer chat encoder attachments", () => {
  const reg = registry()

  it("sends an image as image_url; a URL PDF and video become placeholders", async () => {
    const content = await sentContent(
      reg.resolveModel(VISION),
      { type: "image", source: { kind: "base64", mediaType: "image/png", data: "I" } },
      { type: "image", source: { kind: "url", url: "https://x/a.jpg" } },
      { type: "file", source: { kind: "url", url: "https://x/b.pdf" } },
      { type: "video", source: { kind: "base64", mediaType: "video/mp4", data: "V" } },
    )
    expect(content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,I" } },
      { type: "image_url", image_url: { url: "https://x/a.jpg" } },
      { type: "text", text: `[file attachment not sent: ${VISION} does not accept file]` },
      { type: "text", text: `[video attachment not sent: ${VISION} does not accept video/mp4]` },
    ])
  })

  it("validate rejects audio, PDF and video up front", () => {
    const m = reg.resolveModel(VISION)
    const res = waferAdapter.validate(
      {
        modelId: m.id,
        messages: [
          {
            role: "user",
            content: [
              { type: "audio", source: { kind: "base64", format: "wav", data: "A" } },
              { type: "file", source: { kind: "base64", mediaType: "application/pdf", data: "P" } },
              { type: "video", source: { kind: "url", url: "https://x/v.mp4" } },
            ],
          },
        ],
      },
      m,
    )
    expect(res.errors.filter((e) => String(e.capability) === "modalities")).toHaveLength(3)
  })
})
