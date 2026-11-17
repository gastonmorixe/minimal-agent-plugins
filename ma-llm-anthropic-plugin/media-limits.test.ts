/**
 * Per-model input formats: `Capabilities.inputMimeTypes` per model and the
 * adapter `mediaLimits(model)` hook that reads it.
 */

import { beforeEach, describe, expect, it } from "bun:test"

import { anthropicAdapter, bootstrapAnthropic } from "./adapter.ts"
import {
  ANTHROPIC_DOCUMENT_INPUT_MIME_TYPES,
  ANTHROPIC_IMAGE_INPUT_MIME_TYPES,
  CAPS_HAIKU_45,
  CAPS_OPUS_48,
} from "./capabilities.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { anthropicInputMimeTypes, anthropicMediaLimits } from "./media-limits.ts"
import { registerAnthropicModels } from "./models.ts"

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
const NEVER = [DOCX, XLSX, PPTX, "audio/mpeg", "audio/wav", "video/mp4", "image/bmp"]

let resolveModel: (id: string) => ModelEntry
let modelIds: string[]

beforeEach(() => {
  const reg = makeTestRegistry()
  bootstrapAnthropic(reg.ctx)
  resolveModel = reg.resolveModel
  modelIds = registerAnthropicModels(reg.ctx.models as never)
})

describe("capabilities: inputMimeTypes", () => {
  it("a PDF model takes images, PDF and text docs; no Office, audio or video", () => {
    const list = CAPS_OPUS_48.inputMimeTypes ?? []
    for (const m of [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "application/pdf",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
    ]) {
      expect(list).toContain(m)
    }
    for (const m of NEVER) expect(list).not.toContain(m)
  })

  it("the image-only model (Haiku 4.5) takes images only", () => {
    expect(CAPS_HAIKU_45.inputMimeTypes).toEqual([...ANTHROPIC_IMAGE_INPUT_MIME_TYPES])
  })

  it("every registered model declares a list that agrees with its modality flags", () => {
    expect(modelIds.length).toBeGreaterThan(0)
    for (const m of modelIds.map((id) => resolveModel(id))) {
      const list = m.capabilities.inputMimeTypes
      expect(list, m.id).toBeDefined()
      const hasDocs = ANTHROPIC_DOCUMENT_INPUT_MIME_TYPES.every((d) => list?.includes(d))
      expect(hasDocs, m.id).toBe(m.capabilities.modalities.pdf)
      expect(
        list?.some((x) => x.startsWith("audio/") || x.startsWith("video/")),
        m.id,
      ).toBe(false)
    }
  })
})

describe("mediaLimits(model)", () => {
  it("acceptedMimeTypes is the model's resolved input list", () => {
    const opus = anthropicAdapter.mediaLimits!(resolveModel("claude-opus-4-8"))
    expect([...opus.acceptedMimeTypes].sort()).toEqual(
      [...(CAPS_OPUS_48.inputMimeTypes ?? [])].sort(),
    )
    const haiku = anthropicAdapter.mediaLimits!(resolveModel("claude-haiku-4-5"))
    expect([...haiku.acceptedMimeTypes].sort()).toEqual(
      [...ANTHROPIC_IMAGE_INPUT_MIME_TYPES].sort(),
    )
    expect(haiku.acceptedMimeTypes.has("application/pdf")).toBe(false)
  })

  it("keeps the size and count limits", () => {
    const l = anthropicAdapter.mediaLimits!(resolveModel("claude-opus-4-8"))
    expect(l.maxBytesPerItem).toBe(5 * 1024 * 1024)
    expect(l.maxRequestBytes).toBe(32 * 1024 * 1024)
    expect(l.maxItemsPerRequest).toBe(100)
    expect(l.maxDimension).toBe(8000)
    expect(anthropicMediaLimits({ contextWindow: 100_000 }).maxItemsPerRequest).toBe(600)
  })

  it("a model with no inputMimeTypes falls back to the provider default filtered by flags", () => {
    const { inputMimeTypes: _drop, ...noList } = CAPS_HAIKU_45
    expect(anthropicInputMimeTypes(noList)).toEqual([...ANTHROPIC_IMAGE_INPUT_MIME_TYPES])
    const { inputMimeTypes: _drop2, ...opusNoList } = CAPS_OPUS_48
    expect(anthropicInputMimeTypes(opusNoList)).toContain("text/csv")
    expect(anthropicInputMimeTypes()).toContain("application/pdf")
    for (const m of NEVER) expect(anthropicInputMimeTypes()).not.toContain(m)
  })
})
