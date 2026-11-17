/**
 * Per-model input formats, media limits and the Responses attachment encoder
 * (`input_file`, placeholders).
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"

import { grokAdapter } from "./adapter.ts"
import { GROK_DOCUMENT_MIME_TYPES } from "./capabilities.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { registerGrokModel, registerGrokModels } from "./models.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

function model(): ModelEntry {
  return {
    id: "m",
    providerId: "grok",
    surfaceId: "openai-responses",
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

describe("Grok per-model input formats", () => {
  const reg = makeTestRegistry()
  registerGrokModels(reg.models)
  registerGrokModel({ id: "grok-x-adhoc" }, reg.models)
  const types = (id: string) => reg.resolveModel(id).capabilities.inputMimeTypes ?? []

  it("an agentic Responses model takes jpeg, png, PDF and text documents", () => {
    for (const id of [
      "grok-4.7",
      "grok-4.6",
      "grok-4.5",
      "grok-4.20-reasoning",
      "grok-4.20-non-reasoning",
      "grok-4.20-multi-agent",
    ]) {
      expect(types(id)).toEqual(["image/jpeg", "image/png", ...GROK_DOCUMENT_MIME_TYPES])
      expect(reg.resolveModel(id).capabilities.modalities.pdf).toBe(true)
    }
    expect(GROK_DOCUMENT_MIME_TYPES).toEqual([
      "application/pdf",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
    ])
  })

  it("Chat models, grok-4.3, grok-build and ad-hoc models take jpeg and png only", () => {
    for (const id of ["grok-4.7-chat", "grok-4.5-chat", "grok-4.3", "grok-build", "grok-x-adhoc"]) {
      expect(types(id)).toEqual(["image/jpeg", "image/png"])
      expect(reg.resolveModel(id).capabilities.modalities.pdf).toBe(false)
    }
  })

  it("no model takes gif, webp, Office files, audio or video", () => {
    for (const id of ["grok-4.7", "grok-4.7-chat", "grok-4.20-reasoning"]) {
      const t = types(id)
      expect(t).not.toContain("image/gif")
      expect(t).not.toContain("image/webp")
      expect(t).not.toContain(DOCX)
      expect(t.some((m) => m.startsWith("audio/") || m.startsWith("video/"))).toBe(false)
    }
  })

  it("mediaLimits gives the model list and the 20 MiB image cap", () => {
    const m = reg.resolveModel("grok-4.7")
    const limits = grokAdapter.mediaLimits!(m)
    expect([...limits.acceptedMimeTypes]).toEqual([...types("grok-4.7")])
    expect(limits.maxBytesPerItem).toBe(20 * 1024 * 1024)
    // No list: the jpeg and png default for an image model.
    expect([...grokAdapter.mediaLimits!(model()).acceptedMimeTypes]).toEqual([
      "image/jpeg",
      "image/png",
    ])
  })
})

describe("Grok buildOpenAIResponsesBody attachments", () => {
  const content = (body: ReturnType<typeof buildOpenAIResponsesBody>) =>
    (body.input as Array<{ content: unknown[] }>)[0]!.content

  it("sends a base64 file as input_file with file_data and a filename", () => {
    const body = buildOpenAIResponsesBody(
      req(
        { type: "file", source: { kind: "base64", mediaType: "application/pdf", data: "JVBE" } },
        { type: "file", source: { kind: "base64", mediaType: "text/csv", data: "YQ" } },
      ),
      model(),
    )
    expect(content(body)).toEqual([
      {
        type: "input_file",
        file_data: "data:application/pdf;base64,JVBE",
        filename: "document.pdf",
      },
      { type: "input_file", file_data: "data:text/csv;base64,YQ", filename: "document.csv" },
    ])
  })

  it("keeps the source filename, sends a url as file_url, keeps file_id", () => {
    const body = buildOpenAIResponsesBody(
      req(
        {
          type: "file",
          source: { kind: "base64", mediaType: "text/markdown", data: "Iw", filename: "a.md" },
        },
        { type: "file", source: { kind: "url", url: "https://x/y.pdf", filename: "y.pdf" } },
        { type: "file", source: { kind: "url", url: "https://x/z.pdf" } },
        { type: "file", source: { kind: "file_id", fileId: "file-1" } },
      ),
      model(),
    )
    expect(content(body)).toEqual([
      { type: "input_file", file_data: "data:text/markdown;base64,Iw", filename: "a.md" },
      { type: "input_file", file_url: "https://x/y.pdf", filename: "y.pdf" },
      { type: "input_file", file_url: "https://x/z.pdf" },
      { type: "input_file", file_id: "file-1" },
    ])
  })

  it("sends images as input_image", () => {
    const body = buildOpenAIResponsesBody(
      req({ type: "image", source: { kind: "base64", mediaType: "image/png", data: "iV" } }),
      model(),
    )
    expect(content(body)).toEqual([
      { type: "input_image", image_url: "data:image/png;base64,iV", detail: undefined },
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
      model(),
    )
    expect(content(body)).toEqual([
      { type: "input_text", text: "[audio attachment not sent: m does not accept audio/wav]" },
      { type: "input_text", text: "[video attachment not sent: m does not accept video/mp4]" },
    ])
  })
})
