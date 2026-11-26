/**
 * Input formats and media limits of the Antigravity models.
 *
 * The catalog gives `supportedMimeTypes` per model, so this module uses that
 * value when it exists and falls back to the family list otherwise. Claude
 * rows take images only; the Gemini rows take images, PDF and the document
 * formats they list; GPT-OSS takes no attachment. Video and audio are not
 * accepted: the canonical request has no block for them.
 *
 * Core keeps its default sizes (5 MB per item, 32 MB per request, 100 items,
 * 8000 px).
 *
 * @module llm/providers/antigravity/input-formats
 */

import {
  type Capabilities,
  resolveInputMimeTypes,
} from "@minimal-agent/core/plugin-api/llm/capabilities"
import type { MediaLimits } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

/** Image formats of a vision model. */
export const ANTIGRAVITY_IMAGE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]

/** Document formats of a Gemini model (images included). */
export const ANTIGRAVITY_DOCUMENT_MIME_TYPES: readonly string[] = [
  ...ANTIGRAVITY_IMAGE_MIME_TYPES,
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]

/**
 * Accepted input formats of one model: its `inputMimeTypes`, else the
 * document list for a model with the PDF flag, else the image list, else none.
 */
export function antigravityInputMimeTypes(
  caps: Pick<Capabilities, "modalities" | "inputMimeTypes">,
): readonly string[] {
  if (caps.modalities.pdf) return resolveInputMimeTypes(caps, ANTIGRAVITY_DOCUMENT_MIME_TYPES)
  return resolveInputMimeTypes(caps, ANTIGRAVITY_IMAGE_MIME_TYPES)
}

/** Media limits of one model: its input formats, core default sizes. */
export function antigravityMediaLimits(model: {
  capabilities: Pick<Capabilities, "modalities" | "inputMimeTypes">
}): MediaLimits {
  return {
    acceptedMimeTypes: new Set(antigravityInputMimeTypes(model.capabilities)),
    maxBytesPerItem: 5 * 1024 * 1024,
    maxRequestBytes: 32 * 1024 * 1024,
    maxItemsPerRequest: 100,
    maxDimension: 8000,
  }
}
