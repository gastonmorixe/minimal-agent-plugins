/**
 * Per-model input formats and media limits for ClinePass.
 *
 * ClinePass (api.cline.bot) speaks OpenAI Chat Completions. Its docs do not
 * cover multimodal input (checked 2026-11-17; UNVERIFIED), so a vision model
 * takes images only (`image_url`, the OpenAI shape) and a text model takes no
 * attachment. No PDF, audio or video.
 *
 * The sizes stay the core default (5 MB per item, 32 MB per request, 100
 * items, 8000 px). Only the list differs: the core default also takes PDF
 * and text/plain.
 *
 * @module llm/providers/clinepass/input-formats
 */

import {
  type Capabilities,
  resolveInputMimeTypes,
} from "@minimal-agent/core/plugin-api/llm/capabilities"
import type { MediaLimits } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

/** Image formats for vision models (`image_url`, url or base64). */
export const CLINEPASS_IMAGE_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]

/**
 * The input MIME types of a ClinePass model: its `inputMimeTypes`, else the
 * image formats when the model has the image flag.
 */
export function clinepassInputMimeTypes(
  caps: Pick<Capabilities, "modalities" | "inputMimeTypes">,
): readonly string[] {
  return resolveInputMimeTypes(caps, CLINEPASS_IMAGE_MIME_TYPES)
}

/** The media limits of a ClinePass model: its input formats, core default sizes. */
export function clinepassMediaLimits(model: {
  capabilities: Pick<Capabilities, "modalities" | "inputMimeTypes">
}): MediaLimits {
  return {
    acceptedMimeTypes: new Set(clinepassInputMimeTypes(model.capabilities)),
    maxBytesPerItem: 5 * 1024 * 1024,
    maxRequestBytes: 32 * 1024 * 1024,
    maxItemsPerRequest: 100,
    maxDimension: 8000,
  }
}
