/**
 * Per-model input formats and media limits for Grok (xAI).
 *
 * - Images: jpeg and png only, 20 MiB per image, no count limit.
 * - PDF and text files (txt, md, csv, json): only the agentic models
 *   (grok-4.20, 4.5, 4.6, 4.7) on the Responses surface, as `input_file`.
 * - No Office files, no audio, no video.
 *
 * Each model sets `inputMimeTypes` in `capabilities.ts`. This module gives
 * the provider default (for a model without a list) and the limits.
 *
 * Source: https://docs.x.ai/developers/model-capabilities/images/understanding.md
 * and https://docs.x.ai/developers/model-capabilities/files/chat-with-files.md
 * (2026-11-17).
 *
 * @module llm/providers/grok/input-formats
 */

import {
  type Capabilities,
  resolveInputMimeTypes,
} from "@minimal-agent/core/plugin-api/llm/capabilities"
import type { MediaLimits } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { GROK_IMAGE_MIME_TYPES } from "./capabilities.ts"

/** 20 MiB: the documented cap for one image. */
export const GROK_MAX_IMAGE_BYTES = 20 * 1024 * 1024

/**
 * The input MIME types of a Grok model: its `inputMimeTypes`, else the
 * images (jpeg, png) when the model has the image flag.
 */
export function grokInputMimeTypes(
  caps: Pick<Capabilities, "modalities" | "inputMimeTypes">,
): readonly string[] {
  return resolveInputMimeTypes(caps, GROK_IMAGE_MIME_TYPES)
}

/**
 * The media limits of a Grok model: the model's input types, 20 MiB for one
 * item, core default request total, count and dimension.
 */
export function grokMediaLimits(model: {
  capabilities: Pick<Capabilities, "modalities" | "inputMimeTypes">
}): MediaLimits {
  return {
    acceptedMimeTypes: new Set(grokInputMimeTypes(model.capabilities)),
    maxBytesPerItem: GROK_MAX_IMAGE_BYTES,
    maxRequestBytes: 32 * 1024 * 1024,
    maxItemsPerRequest: 100,
    maxDimension: 8000,
  }
}
