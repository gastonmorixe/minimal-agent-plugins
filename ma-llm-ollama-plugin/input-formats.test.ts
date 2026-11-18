/**
 * Per-model input formats, media limits and the native encoder output for
 * each attachment block (images[] or the core placeholder text).
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { ProviderModelSpec } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { ollamaAdapter } from "./adapter.ts"
import { OLLAMA_IMAGE_MIME_TYPES, ollamaCaps } from "./capabilities.ts"
import type { ModelView } from "./lib/host-types.ts"
import { registerOllamaModels } from "./models.ts"
import { buildOllamaChatBody } from "./request-body.ts"

function model(vision: boolean): ModelView {
  return {
    id: "m",
    providerId: "ollama",
    surfaceId: "custom",
    displayName: "m",
    capabilities: ollamaCaps({ contextWindow: 128_000, vision }),
    pricing: {
      inputUSD: 0,
      outputUSD: 0,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  }
}

function req(...content: CanonicalBlock[]): CanonicalRequest {
  return { modelId: "m", messages: [{ role: "user", content }] }
}

function catalog(): Map<string, ProviderModelSpec> {
  const specs: ProviderModelSpec[] = []
  registerOllamaModels({
    register: (s: ProviderModelSpec) => void specs.push(s),
    setDefault: () => {},
  } as never)
  return new Map(specs.map((s) => [s.id, s]))
}

describe("Ollama per-model input formats", () => {
  it("a vision model takes jpeg, png, gif and webp only", () => {
    const caps = ollamaCaps({ contextWindow: 128_000, vision: true, audio: true })
    expect(caps.inputMimeTypes).toEqual(OLLAMA_IMAGE_MIME_TYPES)
    expect(caps.modalities).toEqual({ image: true, audio: false, pdf: false, video: false })
  })

  it("a text model takes no attachment", () => {
    expect(ollamaCaps({ contextWindow: 128_000 }).inputMimeTypes).toEqual([])
  })

  it("the catalog follows the vision tag", () => {
    const byId = catalog()
    expect(byId.get("deepseek-v4.1-flash")?.capabilities.inputMimeTypes).toEqual(
      OLLAMA_IMAGE_MIME_TYPES,
    )
    expect(byId.get("deepseek-v4-pro:0813")?.capabilities.inputMimeTypes).toEqual([])
  })

  it("mediaLimits gives the model list and the core default sizes", () => {
    const limits = ollamaAdapter.mediaLimits!(model(true) as never)
    expect([...limits.acceptedMimeTypes]).toEqual([...OLLAMA_IMAGE_MIME_TYPES])
    expect(limits.acceptedMimeTypes.has("application/pdf")).toBe(false)
    expect(limits.maxBytesPerItem).toBe(5 * 1024 * 1024)
    expect(limits.maxRequestBytes).toBe(32 * 1024 * 1024)
    expect(limits.maxItemsPerRequest).toBe(100)
    expect(limits.maxDimension).toBe(8000)
    expect(ollamaAdapter.mediaLimits!(model(false) as never).acceptedMimeTypes.size).toBe(0)
  })
})

describe("buildOllamaChatBody attachments", () => {
  const first = (body: ReturnType<typeof buildOllamaChatBody>) => body.messages[0]!

  it("sends a base64 image in images[] with no data URL prefix", () => {
    const msg = first(
      buildOllamaChatBody(
        req(
          { type: "text", text: "see" },
          { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AAA" } },
        ),
        model(true),
      ),
    )
    expect(msg.images).toEqual(["AAA"])
    expect(msg.content).toBe("see")
  })

  it("a url image becomes the placeholder text", () => {
    const msg = first(
      buildOllamaChatBody(
        req({ type: "image", source: { kind: "url", url: "https://x/a.png" } }),
        model(true),
      ),
    )
    expect(msg.images).toBeUndefined()
    expect(msg.content).toBe("[image attachment not sent: m does not accept image]")
  })

  it("audio, PDF and video become placeholder texts, each on its own line", () => {
    const msg = first(
      buildOllamaChatBody(
        req(
          { type: "text", text: "a" },
          { type: "text", text: "b" },
          {
            type: "audio",
            source: { kind: "base64", format: "wav", mediaType: "audio/wav", data: "U" },
          },
          {
            type: "file",
            source: { kind: "base64", mediaType: "application/pdf", data: "P", filename: "x.pdf" },
          },
          { type: "video", source: { kind: "base64", mediaType: "video/mp4", data: "V" } },
        ),
        model(true),
      ),
    )
    expect(msg.content).toBe(
      [
        "ab",
        "[audio attachment not sent: m does not accept audio/wav]",
        "[file attachment not sent: m does not accept application/pdf]",
        "[video attachment not sent: m does not accept video/mp4]",
      ].join("\n"),
    )
    expect(msg.images).toBeUndefined()
  })
})
