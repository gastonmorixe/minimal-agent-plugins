/**
 * Per-model input formats and media limits for Meta (Muse).
 *
 * Multimodal models take images (png, jpeg, gif, webp), PDF, MP4 video and
 * audio (mpeg, wav). Text-only models take no attachments. Each model sets
 * `inputMimeTypes` in `capabilities.ts`; this module gives the provider
 * default (for a model without a list) and the limits: 50 MB inline per
 * item, 50 images per request.
 *
 * Source: https://dev.meta.ai/docs/media-understanding and
 * https://dev.meta.ai/docs/file-handling (2026-11-17).
 *
 * @module llm/providers/meta/input-formats
 */

import {
  type Capabilities,
  resolveInputMimeTypes,
} from "@minimal-agent/core/plugin-api/llm/capabilities"
import type { MediaLimits } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { META_MULTIMODAL_MIME_TYPES } from "./capabilities.ts"

/** 50 MB: the documented inline cap for one item. */
export const META_MAX_INLINE_BYTES = 50 * 1024 * 1024

/** 50 images per request (more returns HTTP 400). */
export const META_MAX_IMAGES_PER_REQUEST = 50

/**
 * The input MIME types of a Meta model: its `inputMimeTypes`, else the
 * multimodal set filtered by the modality flags.
 */
export function metaInputMimeTypes(
  caps: Pick<Capabilities, "modalities" | "inputMimeTypes">,
): readonly string[] {
  return resolveInputMimeTypes(caps, META_MULTIMODAL_MIME_TYPES)
}

/**
 * The media limits of a Meta model: the model's input types, 50 MB for one
 * item and for the request, 50 items, core default dimension.
 */
export function metaMediaLimits(model: {
  capabilities: Pick<Capabilities, "modalities" | "inputMimeTypes">
}): MediaLimits {
  return {
    acceptedMimeTypes: new Set(metaInputMimeTypes(model.capabilities)),
    maxBytesPerItem: META_MAX_INLINE_BYTES,
    maxRequestBytes: META_MAX_INLINE_BYTES,
    maxItemsPerRequest: META_MAX_IMAGES_PER_REQUEST,
    maxDimension: 8000,
  }
}
