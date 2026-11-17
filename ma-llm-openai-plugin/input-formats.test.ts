/**
 * Per-model input formats, media limits and the attachment encoders
 * (Responses `input_file`, Chat `file` and `input_audio`, placeholders).
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"

import { openaiAdapter } from "./adapter.ts"
import { buildOpenAIChatBody } from "./chat/request-body.ts"
import { OPENAI_OFFICE_MIME_TYPES, openAIMediaLimits } from "./input-formats.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { registerOpenAIModels } from "./models.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

function model(surfaceId: string): ModelEntry {
  return {
    id: "m",
    providerId: "openai",
    surfaceId,
    displayName: "m",
    capabilities: {
      ...defaultCapabilities(),
      modalities: { image: true, audio: false, pdf: true, video: false },
    },
    pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0 },
  } as ModelEntry
}

function req(...content: CanonicalBlock[]): CanonicalRequest {
  return { modelId: "m", messages: [{ role: "user", content }] }
}

describe("OpenAI per-model input formats", () => {
  const reg = makeTestRegistry()
  registerOpenAIModels(reg.models)

  it("a Responses model takes images, PDF, text and Office documents", () => {
    const m = reg.resolveModel("gpt-6-astra")
    const types = m.capabilities.inputMimeTypes ?? []
    expect(types).toContain("image/png")
    expect(types).toContain("application/pdf")
    expect(types).toContain("text/csv")
    for (const office of OPENAI_OFFICE_MIME_TYPES) expect(types).toContain(office)
    expect(types.some((t) => t.startsWith("audio/") || t.startsWith("video/"))).toBe(false)
  })

  it("a Chat model takes images and PDF only; gpt-4o also wav and mp3", () => {
    const chat = reg.resolveModel("gpt-6-astra-chat").capabilities.inputMimeTypes ?? []
    expect(chat).toContain("application/pdf")
    expect(chat).not.toContain("text/csv")
    expect(chat).not.toContain(DOCX)
    expect(chat).not.toContain("audio/wav")
    const audio = reg.resolveModel("gpt-4o").capabilities.inputMimeTypes ?? []
    expect(audio).toContain("audio/wav")
    expect(audio).toContain("audio/mpeg")
  })

  it("mediaLimits gives the model list and the 50 MB file cap", () => {
    const m = reg.resolveModel("gpt-6-astra")
    const limits = openaiAdapter.mediaLimits!(m)
    expect([...limits.acceptedMimeTypes]).toEqual([...(m.capabilities.inputMimeTypes ?? [])])
    expect(limits.maxBytesPerItem).toBe(50 * 1024 * 1024)
    expect(openAIMediaLimits(model("openai-chat-completions")).acceptedMimeTypes.has(DOCX)).toBe(
      false,
    )
  })
})

describe("buildOpenAIResponsesBody attachments", () => {
  const content = (body: ReturnType<typeof buildOpenAIResponsesBody>) =>
    (body.input as Array<{ content: unknown[] }>)[0]!.content

  it("sends a base64 file as input_file with file_data and a filename", () => {
    const body = buildOpenAIResponsesBody(
      req({ type: "file", source: { kind: "base64", mediaType: "application/pdf", data: "JVBE" } }),
      model("openai-responses"),
    )
    expect(content(body)).toEqual([
      {
        type: "input_file",
        file_data: "data:application/pdf;base64,JVBE",
        filename: "document.pdf",
      },
    ])
  })

  it("keeps the source filename, sends a url as file_url, keeps file_id", () => {
    const body = buildOpenAIResponsesBody(
      req(
        {
          type: "file",
          source: { kind: "base64", mediaType: DOCX, data: "UEs", filename: "a.docx" },
        },
        { type: "file", source: { kind: "url", url: "https://x/y.pdf" } },
        { type: "file", source: { kind: "file_id", fileId: "file-1" } },
      ),
      model("openai-responses"),
    )
    expect(content(body)).toEqual([
      { type: "input_file", file_data: `data:${DOCX};base64,UEs`, filename: "a.docx" },
      { type: "input_file", file_url: "https://x/y.pdf" },
      { type: "input_file", file_id: "file-1" },
    ])
  })

  it("sends audio and video as placeholder text (no silent drop)", () => {
    const body = buildOpenAIResponsesBody(
      req(
        {
          type: "audio",
          source: { kind: "base64", format: "wav", mediaType: "audio/wav", data: "AA" },
        },
        { type: "video", source: { kind: "base64", mediaType: "video/mp4", data: "AA" } },
      ),
      model("openai-responses"),
    )
    expect(content(body)).toEqual([
      { type: "input_text", text: "[audio attachment not sent: m does not accept audio/wav]" },
      { type: "input_text", text: "[video attachment not sent: m does not accept video/mp4]" },
    ])
  })
})

describe("buildOpenAIChatBody attachments", () => {
  const parts = (body: ReturnType<typeof buildOpenAIChatBody>) =>
    body.messages[0]!.content as unknown[]

  it("sends a base64 PDF as a file part and maps the audio MIME type to format", () => {
    const body = buildOpenAIChatBody(
      req(
        { type: "file", source: { kind: "base64", mediaType: "application/pdf", data: "JVBE" } },
        {
          type: "audio",
          source: { kind: "base64", format: "mpeg", mediaType: "audio/mpeg", data: "AA" },
        },
      ),
      model("openai-chat-completions"),
    )
    expect(parts(body)).toEqual([
      {
        type: "file",
        file: { file_data: "data:application/pdf;base64,JVBE", filename: "document.pdf" },
      },
      { type: "input_audio", input_audio: { data: "AA", format: "mp3" } },
    ])
  })

  it("sends a non-PDF file, a url file, video and a file_id image as placeholders", () => {
    const body = buildOpenAIChatBody(
      req(
        { type: "file", source: { kind: "base64", mediaType: "text/csv", data: "YQ" } },
        { type: "file", source: { kind: "url", url: "https://x/y.pdf" } },
        { type: "video", source: { kind: "url", url: "https://x/v.mp4" } },
        { type: "image", source: { kind: "file_id", fileId: "file-1" } },
      ),
      model("openai-chat-completions"),
    )
    expect(parts(body)).toEqual([
      { type: "text", text: "[file attachment not sent: m does not accept text/csv]" },
      { type: "text", text: "[file attachment not sent: m does not accept file]" },
      { type: "text", text: "[video attachment not sent: m does not accept video]" },
      { type: "text", text: "[image attachment not sent: m does not accept file_id reference]" },
    ])
  })
})
