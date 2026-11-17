/**
 * Per-model input formats and media limits for OpenAI.
 *
 * - Responses API: images (`input_image`), and PDF, text-like and Office
 *   documents (`input_file`). No audio, no video.
 * - Chat Completions: images (`image_url`) and PDF only (`file`). Audio
 *   (`input_audio`, wav and mp3) only on a model with the audio flag.
 *
 * Source: https://developers.openai.com/api/docs/guides/file-inputs and
 * https://developers.openai.com/api/docs/guides/images-vision (2026-11-17).
 * Each file is less than 50 MB, and all files of one request are less than
 * 50 MB in total.
 *
 * @module llm/providers/openai/input-formats
 */

import {
  type Capabilities,
  resolveInputMimeTypes,
} from "@minimal-agent/core/plugin-api/llm/capabilities"
import type { MediaLimits } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

/** Image formats for vision models (no animated GIF). */
export const OPENAI_IMAGE_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]

/** Text and code formats that Responses `input_file` takes. */
export const OPENAI_TEXT_DOCUMENT_MIME_TYPES: readonly string[] = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "text/html",
  "text/css",
  "application/json",
  "application/xml",
]

/** Office formats that Responses `input_file` takes (text extraction). */
export const OPENAI_OFFICE_MIME_TYPES: readonly string[] = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]

/** Audio formats that Chat Completions `input_audio` takes. */
export const OPENAI_CHAT_AUDIO_MIME_TYPES: readonly string[] = ["audio/wav", "audio/mpeg"]

/** Every format the Responses API can take (before the modality filter). */
const RESPONSES_DEFAULT: readonly string[] = [
  ...OPENAI_IMAGE_MIME_TYPES,
  "application/pdf",
  ...OPENAI_TEXT_DOCUMENT_MIME_TYPES,
  ...OPENAI_OFFICE_MIME_TYPES,
]

/** Every format Chat Completions can take (before the modality filter). */
const CHAT_DEFAULT: readonly string[] = [
  ...OPENAI_IMAGE_MIME_TYPES,
  "application/pdf",
  ...OPENAI_CHAT_AUDIO_MIME_TYPES,
]

/** The surface default set: Responses or Chat Completions. */
export function openAISurfaceMimeTypes(surfaceId: string): readonly string[] {
  return surfaceId === "openai-responses" ? RESPONSES_DEFAULT : CHAT_DEFAULT
}

/**
 * The input MIME types of an OpenAI model: its `inputMimeTypes`, else the
 * surface default set filtered by the modality flags.
 */
export function openAIInputMimeTypes(
  caps: Pick<Capabilities, "modalities" | "inputMimeTypes">,
  surfaceId: string,
): readonly string[] {
  return resolveInputMimeTypes(caps, openAISurfaceMimeTypes(surfaceId))
}

/** A copy of `caps` with `inputMimeTypes` set for the surface. */
export function withOpenAIInputMimeTypes(caps: Capabilities, surfaceId: string): Capabilities {
  if (caps.inputMimeTypes !== undefined) return caps
  return { ...caps, inputMimeTypes: openAIInputMimeTypes(caps, surfaceId) }
}

/** 50 MB: the documented cap for one file and for all files of a request. */
export const OPENAI_MAX_FILE_BYTES = 50 * 1024 * 1024

/**
 * The media limits of an OpenAI model: the model's input types, 50 MB for
 * one item and for the request, core default count and dimension.
 */
export function openAIMediaLimits(model: {
  surfaceId: string
  capabilities: Pick<Capabilities, "modalities" | "inputMimeTypes">
}): MediaLimits {
  return {
    acceptedMimeTypes: new Set(openAIInputMimeTypes(model.capabilities, model.surfaceId)),
    maxBytesPerItem: OPENAI_MAX_FILE_BYTES,
    maxRequestBytes: OPENAI_MAX_FILE_BYTES,
    maxItemsPerRequest: 100,
    maxDimension: 8000,
  }
}
