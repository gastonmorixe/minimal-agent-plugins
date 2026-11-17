/**
 * Per-model input formats (live list, else static flags; surface filter) and
 * the three attachment encoders (Responses, Messages, Chat), placeholders.
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import { buildOpenAIChatBody } from "@minimal-agent/core/plugin-api/llm/openai-chat"

import { opencodeAdapter } from "./adapter.ts"
import { opencodeInputMimeTypes } from "./input-formats.ts"
import { buildAnthropicRequestBody } from "./lib/anthropic-request.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { registerOpencodeModels } from "./models.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"

const ALL = { image: true, audio: true, pdf: true, video: true }

function model(surfaceId: string): ModelEntry {
  return {
    id: "m",
    providerId: "opencode-go",
    surfaceId,
    displayName: "m",
    capabilities: { ...defaultCapabilities(), maxOutputTokens: 1024, modalities: ALL },
    pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0 },
  } as ModelEntry
}

function req(...content: CanonicalBlock[]): CanonicalRequest {
  return { modelId: "m", messages: [{ role: "user", content }] }
}

const PDF: CanonicalBlock = {
  type: "file",
  source: { kind: "base64", mediaType: "application/pdf", data: "JVBE" },
}
const CSV: CanonicalBlock = {
  type: "file",
  source: { kind: "base64", mediaType: "text/csv", data: btoa("a,b") },
}
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const DOCX: CanonicalBlock = {
  type: "file",
  source: { kind: "base64", mediaType: DOCX_MIME, data: "UEs" },
}
const WAV: CanonicalBlock = {
  type: "audio",
  source: { kind: "base64", format: "wav", mediaType: "audio/wav", data: "AA" },
}
const MP4: CanonicalBlock = {
  type: "video",
  source: { kind: "base64", mediaType: "video/mp4", data: "AA" },
}

describe("OpenCode Go per-model input formats", () => {
  const reg = makeTestRegistry()
  registerOpencodeModels(reg.models)
  const types = (id: string) => reg.resolveModel(id).capabilities.inputMimeTypes ?? []

  it("a Messages model (Claude) takes images, PDF and text documents", () => {
    expect(types("claude-haiku-5-5")).toEqual([
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "application/pdf",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
    ])
  })

  it("a Responses model (grok-4.7, gpt luna) takes its live images and PDF", () => {
    expect(types("grok-4.7")).toEqual(["image/jpeg", "image/png", "application/pdf"])
    expect(types("gpt-6-luna")).toEqual([
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "application/pdf",
    ])
  })

  it("a Responses Muse model drops the live audio and video (no wire part)", () => {
    const t = types("muse-spark-1.3-contributor")
    expect(t).toContain("application/pdf")
    expect(t.some((m) => m.startsWith("audio/") || m.startsWith("video/"))).toBe(false)
    expect(reg.resolveModel("muse-spark-1.3-contributor").capabilities.modalities).toEqual({
      image: true,
      audio: false,
      pdf: true,
      video: false,
    })
  })

  it("a Chat model keeps live video and wav/mp3 audio, and a text-only model takes nothing", () => {
    const mimo = types("mimo-v2.6-flash")
    expect(mimo).toContain("video/mp4")
    expect(mimo).toContain("audio/wav")
    expect(mimo).toContain("audio/mpeg")
    expect(mimo).not.toContain("audio/flac")
    expect(reg.resolveModel("mimo-v2.6-flash").capabilities.modalities.audio).toBe(true)
    expect(types("glm-5.3-flash")).toEqual([
      "image/jpeg",
      "image/png",
      "video/mp4",
      "video/x-matroska",
      "video/quicktime",
    ])
    expect(types("deepseek-v4-pro")).toEqual([])
    expect(reg.resolveModel("deepseek-v4-pro").capabilities.modalities).toEqual({
      image: false,
      audio: false,
      pdf: false,
      video: false,
    })
  })

  it("a model without a live list uses concrete static types", () => {
    expect(opencodeInputMimeTypes("x-unknown", "openai-chat-completions", ALL)).toEqual([
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "application/pdf",
      "audio/wav",
      "audio/mpeg",
      "video/mp4",
    ])
  })

  it("mediaLimits gives the model list", () => {
    const m = reg.resolveModel("grok-4.7")
    expect([...opencodeAdapter.mediaLimits!(m).acceptedMimeTypes]).toEqual([...types("grok-4.7")])
  })
})

describe("OpenCode Go Responses attachments", () => {
  const content = (body: ReturnType<typeof buildOpenAIResponsesBody>) =>
    (body.input as Array<{ content: unknown[] }>)[0]!.content

  it("sends files as input_file and audio and video as placeholders", () => {
    const body = buildOpenAIResponsesBody(
      req(
        PDF,
        { type: "file", source: { kind: "url", url: "https://x/y.pdf" } },
        { type: "file", source: { kind: "file_id", fileId: "file-1" } },
        WAV,
        MP4,
      ),
      model("openai-responses"),
    )
    expect(content(body)).toEqual([
      {
        type: "input_file",
        file_data: "data:application/pdf;base64,JVBE",
        filename: "document.pdf",
      },
      { type: "input_file", file_url: "https://x/y.pdf" },
      { type: "input_file", file_id: "file-1" },
      { type: "input_text", text: "[audio attachment not sent: m does not accept audio/wav]" },
      { type: "input_text", text: "[video attachment not sent: m does not accept video/mp4]" },
    ])
  })
})

describe("OpenCode Go Messages attachments", () => {
  const content = (body: ReturnType<typeof buildAnthropicRequestBody>) =>
    body.messages[0]!.content as unknown[]

  it("sends PDF and text documents as document blocks, the rest as placeholders", () => {
    const body = buildAnthropicRequestBody(
      req(
        PDF,
        CSV,
        { type: "file", source: { kind: "url", url: "https://x/y.pdf" } },
        DOCX,
        { type: "file", source: { kind: "file_id", fileId: "file_1" } },
        { type: "image", source: { kind: "file_id", fileId: "file_2" } },
        WAV,
        MP4,
      ),
      model("anthropic-messages"),
    )
    expect(content(body)).toEqual([
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBE" } },
      { type: "document", source: { type: "text", media_type: "text/plain", data: "a,b" } },
      { type: "document", source: { type: "url", url: "https://x/y.pdf" } },
      { type: "text", text: `[file attachment not sent: m does not accept ${DOCX_MIME}]` },
      { type: "text", text: "[file attachment not sent: m does not accept file_id reference]" },
      { type: "text", text: "[image attachment not sent: m does not accept file_id reference]" },
      { type: "text", text: "[audio attachment not sent: m does not accept audio/wav]" },
      { type: "text", text: "[video attachment not sent: m does not accept video/mp4]" },
    ])
  })
})

describe("OpenCode Go Chat attachments (shared encoder, video on)", () => {
  it("sends PDF as file, audio as input_audio, video as video_url; a text file as a placeholder", () => {
    const body = buildOpenAIChatBody(
      req(PDF, WAV, MP4, CSV),
      model("openai-chat-completions"),
      undefined,
      { video: true },
    )
    expect(body.messages[0]!.content).toEqual([
      {
        type: "file",
        file: { file_data: "data:application/pdf;base64,JVBE", filename: "document.pdf" },
      },
      { type: "input_audio", input_audio: { data: "AA", format: "wav" } },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AA" } },
      { type: "text", text: "[file attachment not sent: m does not accept text/csv]" },
    ])
  })
})
