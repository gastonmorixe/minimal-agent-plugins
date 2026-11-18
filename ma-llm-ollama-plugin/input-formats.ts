/**
 * Per-model input formats and media limits for Ollama Cloud.
 *
 * The native `/api/chat` takes base64 images in `images[]` on vision models
 * only. It has no slot for audio, PDF or video (audio goes only to the
 * separate `/v1/audio/transcriptions` endpoint). Sources:
 * https://docs.ollama.com/capabilities/vision and
 * https://docs.ollama.com/api/openai-compatibility.md (2026-11-17).
 *
 * The sizes stay the core default (5 MB per item, 32 MB per request, 100
 * items, 8000 px). Only the format list differs: the core default also takes
 * PDF and text/plain.
 *
 * @module llm/providers/ollama/input-formats
 */

import {
  type Capabilities,
  resolveInputMimeTypes,
} from "@minimal-agent/core/plugin-api/llm/capabilities"
import type { MediaLimits } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { OLLAMA_IMAGE_MIME_TYPES } from "./capabilities.ts"

/**
 * The input MIME types of an Ollama model: its `inputMimeTypes`, else the
 * image formats filtered by the modality flags.
 */
export function ollamaInputMimeTypes(
  caps: Pick<Capabilities, "modalities" | "inputMimeTypes">,
): readonly string[] {
  return resolveInputMimeTypes(caps, OLLAMA_IMAGE_MIME_TYPES)
}

/** The media limits of an Ollama model: its input formats, core default sizes. */
export function ollamaMediaLimits(model: {
  capabilities: Pick<Capabilities, "modalities" | "inputMimeTypes">
}): MediaLimits {
  return {
    acceptedMimeTypes: new Set(ollamaInputMimeTypes(model.capabilities)),
    maxBytesPerItem: 5 * 1024 * 1024,
    maxRequestBytes: 32 * 1024 * 1024,
    maxItemsPerRequest: 100,
    maxDimension: 8000,
  }
}
