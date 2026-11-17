/**
 * Per-model input formats and media limits for HuggingFace Inference
 * Providers.
 *
 * The router speaks OpenAI Chat Completions and takes `image_url` parts on
 * vision models (https://huggingface.co/docs/inference-providers/tasks/chat-completion,
 * checked 2026-11-17). The docs name no PDF, audio or video input, so a
 * vision model takes images only and a text model takes no attachment. The
 * sizes stay the core default (5 MB per item, 32 MB per request, 100 items,
 * 8000 px); only the list differs (the core default also takes PDF and
 * text/plain).
 *
 * @module llm/providers/huggingface/input-formats
 */

import {
  type Capabilities,
  resolveInputMimeTypes,
} from "@minimal-agent/core/plugin-api/llm/capabilities"
import type { MediaLimits } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

/** Image formats for vision models (`image_url`, url or base64). */
export const HUGGINGFACE_IMAGE_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]

/**
 * The input MIME types of a HuggingFace model: its `inputMimeTypes`, else the
 * image formats when the model has the image flag.
 */
export function huggingFaceInputMimeTypes(
  caps: Pick<Capabilities, "modalities" | "inputMimeTypes">,
): readonly string[] {
  return resolveInputMimeTypes(caps, HUGGINGFACE_IMAGE_MIME_TYPES)
}

/** The media limits of a HuggingFace model: its input formats, core default sizes. */
export function huggingFaceMediaLimits(model: {
  capabilities: Pick<Capabilities, "modalities" | "inputMimeTypes">
}): MediaLimits {
  return {
    acceptedMimeTypes: new Set(huggingFaceInputMimeTypes(model.capabilities)),
    maxBytesPerItem: 5 * 1024 * 1024,
    maxRequestBytes: 32 * 1024 * 1024,
    maxItemsPerRequest: 100,
    maxDimension: 8000,
  }
}
