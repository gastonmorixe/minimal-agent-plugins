/**
 * Per-model input formats, media limits and the chat encoder output for each
 * attachment block (image_url, file, input_audio, video_url, placeholder).
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"

import { bootstrapOpenRouter, openrouterAdapter } from "./adapter.ts"
import {
  OPENROUTER_AUDIO_MIME_TYPES,
  OPENROUTER_IMAGE_MIME_TYPES,
  OPENROUTER_VIDEO_MIME_TYPES,
  openRouterInputMimeTypes,
} from "./capabilities.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { registerOpenRouterModelInto } from "./models.ts"

function registry() {
  const reg = makeTestRegistry()
  bootstrapOpenRouter({ models: reg.models, providers: reg.providers })
  return reg
}

function req(...content: CanonicalBlock[]): CanonicalRequest {
  return { modelId: "x-ai/grok-4.7", messages: [{ role: "user", content }], stream: false }
}

const hasVideo = (types: readonly string[]) => types.some((t) => t.startsWith("video/"))
const hasAudio = (types: readonly string[]) => types.some((t) => t.startsWith("audio/"))

describe("OpenRouter per-model input formats", () => {
  const reg = registry()

  it("every model takes png, jpeg, webp, gif and PDF", () => {
    for (const id of ["deepseek/deepseek-v4.1-flash", "x-ai/grok-4.7", "openai/gpt-4o-mini"]) {
      const types = reg.resolveModel(id).capabilities.inputMimeTypes ?? []
      expect(types).toEqual([...OPENROUTER_IMAGE_MIME_TYPES, "application/pdf"])
      expect(reg.resolveModel(id).capabilities.modalities.pdf).toBe(true)
    }
  })

  it("a video model also takes mp4, mpeg, mov and webm (no audio)", () => {
    const types = reg.resolveModel("moonshotai/kimi-k3.1-pro").capabilities.inputMimeTypes ?? []
    for (const v of OPENROUTER_VIDEO_MIME_TYPES) expect(types).toContain(v)
    expect(hasAudio(types)).toBe(false)
  })

  it("wav and mp3 only on a model with audio input", () => {
    const audio = openRouterInputMimeTypes({
      modalities: { image: true, audio: true, pdf: true, video: false },
    })
    expect(audio).toEqual([
      ...OPENROUTER_IMAGE_MIME_TYPES,
      "application/pdf",
      ...OPENROUTER_AUDIO_MIME_TYPES,
    ])
    expect(hasVideo(audio)).toBe(false)
  })

  it("an ad-hoc slug takes images and PDF", () => {
    const r = makeTestRegistry()
    registerOpenRouterModelInto(r.models, { id: "acme/new-model" })
    const types = r.resolveModel("acme/new-model").capabilities.inputMimeTypes
    expect(types).toEqual([...OPENROUTER_IMAGE_MIME_TYPES, "application/pdf"])
  })

  it("mediaLimits gives the model list and the core default sizes", () => {
    const m = reg.resolveModel("moonshotai/kimi-k3.1-pro")
    const limits = openrouterAdapter.mediaLimits!(m)
    expect([...limits.acceptedMimeTypes]).toEqual([...(m.capabilities.inputMimeTypes ?? [])])
    expect(limits.acceptedMimeTypes.has("text/plain")).toBe(false)
    expect(limits.maxBytesPerItem).toBe(5 * 1024 * 1024)
    expect(limits.maxRequestBytes).toBe(32 * 1024 * 1024)
    expect(limits.maxItemsPerRequest).toBe(100)
    expect(limits.maxDimension).toBe(8000)
  })
})

describe("OpenRouter chat encoder attachments", () => {
  const reg = registry()

  /** Run the adapter with a fake network client and capture the sent body. */
  async function sentContent(model: ModelEntry, ...content: CanonicalBlock[]): Promise<unknown> {
    let sent = ""
    const networkClient = {
      request: async (r: { body: string }) => {
        sent = r.body
        throw new Error("stop")
      },
    }
    try {
      for await (const _ of openrouterAdapter.run(req(...content), model, {
        auth: { kind: "api-key", key: "k" },
        networkClient,
      } as never)) {
        // no events: the fake client throws first
      }
    } catch {
      // expected
    }
    const body = JSON.parse(sent) as { messages: Array<{ content: unknown }> }
    return body.messages[0]?.content
  }

  it("sends image, PDF, audio and video parts", async () => {
    const m = reg.resolveModel("moonshotai/kimi-k3.1-pro")
    const content = await sentContent(
      m,
      { type: "image", source: { kind: "base64", mediaType: "image/png", data: "I" } },
      {
        type: "file",
        source: { kind: "base64", mediaType: "application/pdf", data: "P", filename: "a.pdf" },
      },
      { type: "file", source: { kind: "url", url: "https://x/b.pdf" } },
      {
        type: "audio",
        source: { kind: "base64", format: "mpeg", mediaType: "audio/mpeg", data: "A" },
      },
      { type: "video", source: { kind: "url", url: "https://x/v.mp4" } },
      { type: "video", source: { kind: "base64", mediaType: "video/webm", data: "V" } },
    )
    expect(content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,I" } },
      { type: "file", file: { file_data: "data:application/pdf;base64,P", filename: "a.pdf" } },
      { type: "file", file: { file_data: "https://x/b.pdf", filename: "document.pdf" } },
      { type: "input_audio", input_audio: { data: "A", format: "mp3" } },
      { type: "video_url", video_url: { url: "https://x/v.mp4" } },
      { type: "video_url", video_url: { url: "data:video/webm;base64,V" } },
    ])
  })

  it("a block it cannot send becomes the placeholder text", async () => {
    const m = reg.resolveModel("x-ai/grok-4.7")
    const content = await sentContent(
      m,
      { type: "text", text: "see" },
      { type: "file", source: { kind: "base64", mediaType: "text/csv", data: "C" } },
      { type: "audio", source: { kind: "url", url: "https://x/a.wav" } },
    )
    expect(content).toEqual([
      { type: "text", text: "see" },
      { type: "text", text: "[file attachment not sent: x-ai/grok-4.7 does not accept text/csv]" },
      { type: "text", text: "[audio attachment not sent: x-ai/grok-4.7 does not accept audio]" },
    ])
  })
})
