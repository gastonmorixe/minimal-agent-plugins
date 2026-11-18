/**
 * Input formats and media limits for the generic endpoint.
 *
 * The server is the user's own, so its formats are not known. Treat it as an
 * OpenAI Chat Completions server with images only (`image_url`): no PDF,
 * audio or video, whatever the codec could encode. Image input is on when
 * the codec's default capabilities set the image flag, or when the user
 * config (`MINIMAL_AGENT_IMAGE_INPUT`) turns it on or off.
 *
 * The sizes stay the core default (5 MB per item, 32 MB per request, 100
 * items, 8000 px). Only the list differs: the core default also takes PDF
 * and text/plain.
 *
 * @module llm/providers/generic-endpoint/input-formats
 */

import {
  type Capabilities,
  resolveInputMimeTypes,
} from "@minimal-agent/core/plugin-api/llm/capabilities"
import type { MediaLimits } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

/** Image formats for an image-input model (`image_url`, url or base64). */
export const GENERIC_IMAGE_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]

/**
 * Narrow codec default capabilities to images only.
 *
 * @param caps - The codec default capabilities.
 * @param imageInput - The user override. Absent: the codec image flag.
 * @returns A copy with only the image flag (maybe) on, and the image list.
 */
export function genericImageOnlyCaps(caps: Capabilities, imageInput?: boolean): Capabilities {
  const image = imageInput ?? caps.modalities.image
  // A codec list keeps only its image types; else the default image formats.
  const codecImages = caps.inputMimeTypes?.filter((m) => m.toLowerCase().startsWith("image/"))
  const images =
    codecImages && codecImages.length > 0 && imageInput === undefined
      ? codecImages
      : GENERIC_IMAGE_MIME_TYPES
  return {
    ...caps,
    modalities: { image, audio: false, pdf: false, video: false },
    inputMimeTypes: image ? images : [],
  }
}

/** The media limits of a generic-endpoint model: its input formats, core default sizes. */
export function genericMediaLimits(model: {
  capabilities: Pick<Capabilities, "modalities" | "inputMimeTypes">
}): MediaLimits {
  return {
    acceptedMimeTypes: new Set(resolveInputMimeTypes(model.capabilities, GENERIC_IMAGE_MIME_TYPES)),
    maxBytesPerItem: 5 * 1024 * 1024,
    maxRequestBytes: 32 * 1024 * 1024,
    maxItemsPerRequest: 100,
    maxDimension: 8000,
  }
}
