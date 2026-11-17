/**
 * Per-model input formats and media limits for Wafer.
 *
 * Wafer Chat Completions content is `text` and `image_url` only
 * (https://docs.wafer.ai/serverless/chat-completions.md), and `/v1/messages`
 * has no PDF `document` block (https://docs.wafer.ai/serverless/messages.md;
 * both checked 2026-11-17). A vision model takes images only; a text model
 * takes no attachment.
 *
 * The sizes stay the core default (5 MB per item, 32 MB per request, 100
 * items, 8000 px). Only the list differs: the core default also takes PDF
 * and text/plain.
 *
 * @module llm/providers/wafer/input-formats
 */

import {
  type Capabilities,
  resolveInputMimeTypes,
} from "@minimal-agent/core/plugin-api/llm/capabilities"
import type { MediaLimits } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

/** Image formats for vision models (`image_url`, url or base64). */
export const WAFER_IMAGE_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]

/**
 * The input MIME types of a Wafer model: its `inputMimeTypes`, else the
 * image formats when the model has the image flag.
 */
export function waferInputMimeTypes(
  caps: Pick<Capabilities, "modalities" | "inputMimeTypes">,
): readonly string[] {
  return resolveInputMimeTypes(caps, WAFER_IMAGE_MIME_TYPES)
}

/** The images-only list for a modality record: the image formats, or none. */
export function waferImageInput(modalities: { image: boolean }): readonly string[] {
  return modalities.image ? WAFER_IMAGE_MIME_TYPES : []
}

/** The media limits of a Wafer model: its input formats, core default sizes. */
export function waferMediaLimits(model: {
  capabilities: Pick<Capabilities, "modalities" | "inputMimeTypes">
}): MediaLimits {
  return {
    acceptedMimeTypes: new Set(waferInputMimeTypes(model.capabilities)),
    maxBytesPerItem: 5 * 1024 * 1024,
    maxRequestBytes: 32 * 1024 * 1024,
    maxItemsPerRequest: 100,
    maxDimension: 8000,
  }
}
