/**
 * Per-model input formats and media limits for OpenCode Zen.
 *
 * 1. A model in the live-catalog snapshot (`live-input.ts`, from
 *    `GET /v1/models` `modalities.input`) uses its live list. A bare
 *    `image` entry means the four common image types.
 * 2. Else the static modality flags give concrete types: images (jpeg, png,
 *    gif, webp), `application/pdf`, audio (`audio/wav`, `audio/mpeg`) and
 *    video (`video/mp4`).
 *
 * Then the list keeps only the types that the surface encoder can send. The
 * encoders turn every other block into the core placeholder text:
 * - `openai-chat-completions`: images (`image_url`), PDF (`file`), wav and
 *   mp3 (`input_audio`), video (`video_url`).
 * - `openai-responses`: images (`input_image`), PDF (`input_file`). No audio
 *   or video.
 * - `anthropic-messages`: jpeg, png, gif and webp images, PDF and text
 *   documents (`document`; text goes as `text/plain`). No audio or video.
 *
 * The modality flags are set again from the final list, so the flags and the
 * list agree.
 *
 * @module llm/providers/opencode-zen/input-formats
 */

import {
  type Capabilities,
  type ModalitySupport,
  mimeModality,
  resolveInputMimeTypes,
} from "@minimal-agent/core/plugin-api/llm/capabilities"
import { isTextLikeMime } from "@minimal-agent/core/plugin-api/llm/modality-check"
import { chatAudioFormat } from "@minimal-agent/core/plugin-api/llm/openai-chat"
import type { MediaLimits } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { LIVE_INPUT_MODALITIES } from "./live-input.ts"

/** The common image types (also the expansion of a bare `image` entry). */
export const OPENCODE_IMAGE_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]

/** Static audio types for a model with the audio flag (chat `input_audio`). */
export const OPENCODE_STATIC_AUDIO_MIME_TYPES: readonly string[] = ["audio/wav", "audio/mpeg"]

/** Static video types for a model with the video flag. */
export const OPENCODE_STATIC_VIDEO_MIME_TYPES: readonly string[] = ["video/mp4"]

/** Text documents that the Messages encoder sends as a `text/plain` document. */
export const OPENCODE_TEXT_DOCUMENT_MIME_TYPES: readonly string[] = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]

/** The static default set of a model, from its modality flags. */
function staticMimeTypes(modalities: ModalitySupport): readonly string[] {
  return resolveInputMimeTypes({ modalities }, [
    ...OPENCODE_IMAGE_MIME_TYPES,
    "application/pdf",
    ...OPENCODE_STATIC_AUDIO_MIME_TYPES,
    ...OPENCODE_STATIC_VIDEO_MIME_TYPES,
  ])
}

/** The live list of a model, without `text`, with `image` expanded. */
export function liveMimeTypes(modelId: string): readonly string[] | undefined {
  const raw = LIVE_INPUT_MODALITIES[modelId]
  if (!raw) return undefined
  const out: string[] = []
  for (const entry of raw) {
    const m = entry.toLowerCase()
    if (m === "text") continue
    if (m === "image") out.push(...OPENCODE_IMAGE_MIME_TYPES)
    else if (m === "pdf") out.push("application/pdf")
    else if (m.includes("/")) out.push(m)
  }
  return [...new Set(out)]
}

/** True when the encoder of `surfaceId` can send one block of type `mime`. */
export function surfaceSendsMime(surfaceId: string, mime: string): boolean {
  const m = mime.toLowerCase()
  const kind = mimeModality(m)
  const chat = surfaceId === "openai-chat-completions"
  const messages = surfaceId === "anthropic-messages"
  if (kind === "image") return messages ? OPENCODE_IMAGE_MIME_TYPES.includes(m) : true
  if (kind === "audio") {
    const format = chatAudioFormat({ format: "", mediaType: m })
    return chat && (format === "wav" || format === "mp3")
  }
  if (kind === "video") return chat
  if (m === "application/pdf") return true
  return messages && isTextLikeMime(m)
}

/**
 * The input MIME types of an OpenCode model on its surface: the live list
 * (else the static set), filtered to what the surface encoder sends. A
 * Messages model with PDF also takes the text documents.
 */
export function opencodeInputMimeTypes(
  modelId: string,
  surfaceId: string,
  modalities: ModalitySupport,
): readonly string[] {
  const base = [...(liveMimeTypes(modelId) ?? staticMimeTypes(modalities))]
  if (surfaceId === "anthropic-messages" && base.includes("application/pdf")) {
    base.push(...OPENCODE_TEXT_DOCUMENT_MIME_TYPES)
  }
  return [...new Set(base.filter((m) => surfaceSendsMime(surfaceId, m)))]
}

/** The modality flags that agree with a MIME list. */
export function modalitiesFromMimeTypes(types: readonly string[]): ModalitySupport {
  const kinds = new Set(types.map((m) => mimeModality(m)))
  return {
    image: kinds.has("image"),
    audio: kinds.has("audio"),
    pdf: kinds.has("pdf"),
    video: kinds.has("video"),
  }
}

/** A copy of `caps` with `inputMimeTypes` and the matching modality flags. */
export function withOpencodeInputMimeTypes(
  caps: Capabilities,
  modelId: string,
  surfaceId: string,
): Capabilities {
  const inputMimeTypes = opencodeInputMimeTypes(modelId, surfaceId, caps.modalities)
  return { ...caps, inputMimeTypes, modalities: modalitiesFromMimeTypes(inputMimeTypes) }
}

/**
 * The media limits of an OpenCode model: its input types and the core
 * default budget (the gateway documents no size cap; UNVERIFIED).
 */
export function opencodeMediaLimits(model: {
  capabilities: Pick<Capabilities, "modalities" | "inputMimeTypes">
}): MediaLimits {
  return {
    acceptedMimeTypes: new Set(
      resolveInputMimeTypes(model.capabilities, staticMimeTypes(model.capabilities.modalities)),
    ),
    maxBytesPerItem: 5 * 1024 * 1024,
    maxRequestBytes: 32 * 1024 * 1024,
    maxItemsPerRequest: 100,
    maxDimension: 8000,
  }
}
