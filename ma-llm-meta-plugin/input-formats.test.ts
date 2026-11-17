/**
 * Per-model input formats, media limits and the attachment encoders
 * (Responses `input_file` / `input_video` / `input_audio`, Chat `file` /
 * `video_url` / `input_audio`, placeholders).
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import { buildOpenAIChatBody } from "@minimal-agent/core/plugin-api/llm/openai-chat"

import { metaAdapter } from "./adapter.ts"
import { META_MULTIMODAL_MIME_TYPES } from "./capabilities.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { registerMetaModel, registerMetaModels } from "./models.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"

function model(surfaceId = "openai-responses"): ModelEntry {
  return {
    id: "m",
    providerId: "meta",
    surfaceId,
    displayName: "m",
    capabilities: {
      ...defaultCapabilities(),
      modalities: { image: true, audio: true, pdf: true, video: true },
    },
    pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0 },
  } as ModelEntry
}

function req(...content: CanonicalBlock[]): CanonicalRequest {
  return { modelId: "m", messages: [{ role: "user", content }] }
}

const WAV: CanonicalBlock = {
  type: "audio",
  source: { kind: "base64", format: "wav", mediaType: "audio/wav", data: "AA" },
}
const MP3: CanonicalBlock = {
  type: "audio",
  source: { kind: "base64", format: "mpeg", mediaType: "audio/mpeg", data: "AA" },
}

describe("Meta per-model input formats", () => {
  const reg = makeTestRegistry()
  registerMetaModels(reg.models)
  registerMetaModel({ id: "muse-spark-9-adhoc" }, reg.models)

  it("every multimodal model takes images, PDF, mp4 and mpeg/wav audio", () => {
    expect(META_MULTIMODAL_MIME_TYPES).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "application/pdf",
      "video/mp4",
      "audio/mpeg",
      "audio/wav",
    ])
    for (const id of [
      "muse-spark-1.3",
      "muse-spark-1.3-chat",
      "muse-spark-1.2",
      "muse-wonder-1.0",
      "muse-spark-9-adhoc",
    ]) {
      const caps = reg.resolveModel(id).capabilities
      expect(caps.inputMimeTypes).toEqual(META_MULTIMODAL_MIME_TYPES)
      expect(caps.modalities).toEqual({ image: true, audio: true, pdf: true, video: true })
    }
  })

  it("no model takes text or Office documents", () => {
    const t = reg.resolveModel("muse-spark-1.3").capabilities.inputMimeTypes ?? []
    expect(t).not.toContain("text/plain")
    expect(t).not.toContain("application/json")
  })

  it("mediaLimits gives the model list, 50 MB inline and 50 items", () => {
    const m = reg.resolveModel("muse-spark-1.3")
    const limits = metaAdapter.mediaLimits!(m)
    expect([...limits.acceptedMimeTypes]).toEqual([...META_MULTIMODAL_MIME_TYPES])
    expect(limits.maxBytesPerItem).toBe(50 * 1024 * 1024)
    expect(limits.maxItemsPerRequest).toBe(50)
  })
})

describe("Meta buildOpenAIResponsesBody attachments", () => {
  const content = (body: ReturnType<typeof buildOpenAIResponsesBody>) =>
    (body.input as Array<{ content: unknown[] }>)[0]!.content

  it("sends files as input_file (file_data, file_url, file_id)", () => {
    const body = buildOpenAIResponsesBody(
      req(
        { type: "file", source: { kind: "base64", mediaType: "application/pdf", data: "JVBE" } },
        { type: "file", source: { kind: "url", url: "https://x/y.pdf" } },
        { type: "file", source: { kind: "file_id", fileId: "file-1" } },
      ),
      model(),
    )
    expect(content(body)).toEqual([
      {
        type: "input_file",
        file_data: "data:application/pdf;base64,JVBE",
        filename: "document.pdf",
      },
      { type: "input_file", file_url: "https://x/y.pdf" },
      { type: "input_file", file_id: "file-1" },
    ])
  })

  it("sends video as input_video and audio as input_audio", () => {
    const body = buildOpenAIResponsesBody(
      req(
        { type: "video", source: { kind: "base64", mediaType: "video/mp4", data: "AA" } },
        { type: "video", source: { kind: "url", url: "https://x/v.mp4" } },
        { type: "video", source: { kind: "file_id", fileId: "file-2" } },
        WAV,
        MP3,
      ),
      model(),
    )
    expect(content(body)).toEqual([
      { type: "input_video", video_url: "data:video/mp4;base64,AA" },
      { type: "input_video", video_url: "https://x/v.mp4" },
      { type: "input_video", file_id: "file-2" },
      { type: "input_audio", input_audio: { data: "AA", format: "wav" } },
      { type: "input_audio", input_audio: { data: "AA", format: "mp3" } },
    ])
  })

  it("sends a url audio as placeholder text (no silent drop)", () => {
    const body = buildOpenAIResponsesBody(
      req({ type: "audio", source: { kind: "url", url: "https://x/a.wav" } }),
      model(),
    )
    expect(content(body)).toEqual([
      { type: "input_text", text: "[audio attachment not sent: m does not accept audio]" },
    ])
  })
})

describe("Meta Chat Completions attachments (shared encoder, video on)", () => {
  const parts = (body: ReturnType<typeof buildOpenAIChatBody>) =>
    body.messages[0]!.content as unknown[]

  it("sends PDF as file, video as video_url, audio as input_audio", () => {
    const body = buildOpenAIChatBody(
      req(
        { type: "file", source: { kind: "base64", mediaType: "application/pdf", data: "JVBE" } },
        { type: "video", source: { kind: "base64", mediaType: "video/mp4", data: "AA" } },
        MP3,
      ),
      model("openai-chat-completions"),
      undefined,
      { video: true },
    )
    expect(parts(body)).toEqual([
      {
        type: "file",
        file: { file_data: "data:application/pdf;base64,JVBE", filename: "document.pdf" },
      },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AA" } },
      { type: "input_audio", input_audio: { data: "AA", format: "mp3" } },
    ])
  })

  it("sends a text file and a url file as placeholders", () => {
    const body = buildOpenAIChatBody(
      req(
        { type: "file", source: { kind: "base64", mediaType: "text/plain", data: "YQ" } },
        { type: "file", source: { kind: "url", url: "https://x/y.pdf" } },
      ),
      model("openai-chat-completions"),
      undefined,
      { video: true },
    )
    expect(parts(body)).toEqual([
      { type: "text", text: "[file attachment not sent: m does not accept text/plain]" },
      { type: "text", text: "[file attachment not sent: m does not accept file]" },
    ])
  })
})
