/**
 * Media limits for OpenRouter models.
 *
 * The format list is per model (`inputMimeTypes`, see `capabilities.ts`):
 * images and PDF on every model, wav and mp3 audio only on a model with audio
 * input, mp4, mpeg, mov and webm video only on a model with video input. The
 * sizes stay the core default (5 MB per item, 32 MB per request, 100 items,
 * 8000 px).
 *
 * @module llm/providers/openrouter/input-formats
 */

import type { Capabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import type { MediaLimits } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { openRouterInputMimeTypes } from "./capabilities.ts"

/** The media limits of an OpenRouter model: its input formats, core default sizes. */
export function openRouterMediaLimits(model: {
  capabilities: Pick<Capabilities, "modalities" | "inputMimeTypes">
}): MediaLimits {
  return {
    acceptedMimeTypes: new Set(openRouterInputMimeTypes(model.capabilities)),
    maxBytesPerItem: 5 * 1024 * 1024,
    maxRequestBytes: 32 * 1024 * 1024,
    maxItemsPerRequest: 100,
    maxDimension: 8000,
  }
}
